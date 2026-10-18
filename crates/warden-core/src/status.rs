use sha2::{Digest, Sha256};

use crate::{GitReadError, GitReadErrorKind, WorktreeState};

fn invalid(message: &str) -> GitReadError {
    GitReadError::new(
        GitReadErrorKind::InvalidOutput,
        format!("invalid git status output: {message}"),
    )
}

fn is_object_id(value: &[u8]) -> bool {
    matches!(value.len(), 40 | 64) && value.iter().all(u8::is_ascii_hexdigit)
}

/// Split only the fixed metadata prefix. The remaining pathname may contain any non-NUL bytes,
/// including spaces, tabs, line breaks, or text that looks like another status record.
fn fields<const N: usize>(record: &[u8]) -> Result<([&[u8]; N], &[u8]), GitReadError> {
    let mut fields = [&[][..]; N];
    let mut remaining = record;
    for field in &mut fields {
        let separator = remaining
            .iter()
            .position(|byte| *byte == b' ')
            .ok_or_else(|| invalid("incomplete tracked entry"))?;
        *field = &remaining[..separator];
        if field.is_empty() {
            return Err(invalid("empty metadata field"));
        }
        remaining = &remaining[separator + 1..];
    }
    if remaining.is_empty() {
        return Err(invalid("empty pathname"));
    }
    Ok((fields, remaining))
}

fn validate_tracked(fields: &[&[u8]], unmerged: bool) -> Result<(), GitReadError> {
    let xy = fields[1];
    if xy.len() != 2 || !xy.iter().all(|byte| b".MTADRCU".contains(byte)) {
        return Err(invalid("invalid index/worktree status"));
    }
    let submodule = fields[2];
    if submodule != b"N..."
        && !(submodule.len() == 4
            && submodule[0] == b'S'
            && b".C".contains(&submodule[1])
            && b".M".contains(&submodule[2])
            && b".U".contains(&submodule[3]))
    {
        return Err(invalid("invalid submodule state"));
    }
    let mode_end = if unmerged { 7 } else { 6 };
    if !fields[3..mode_end]
        .iter()
        .all(|field| field.len() == 6 && field.iter().all(|byte| (b'0'..=b'7').contains(byte)))
    {
        return Err(invalid("invalid file mode"));
    }
    let object_end = if unmerged { 10 } else { 8 };
    if !fields[mode_end..object_end]
        .iter()
        .all(|field| is_object_id(field))
    {
        return Err(invalid("invalid index object id"));
    }
    Ok(())
}

pub(crate) fn parse(output: &[u8]) -> Result<WorktreeState, GitReadError> {
    let terminated = output
        .strip_suffix(b"\0")
        .ok_or_else(|| invalid("missing final NUL"))?;
    let mut records = terminated.split(|byte| *byte == 0);
    let mut head = None;
    let mut branch = None;
    let mut saw_head = false;
    let mut saw_branch = false;
    let mut dirty_count = 0u32;
    let mut paths = Vec::new();

    while let Some(record) = records.next() {
        if let Some(value) = record.strip_prefix(b"# branch.oid ") {
            if saw_head {
                return Err(invalid("duplicate branch object id"));
            }
            saw_head = true;
            if value != b"(initial)" {
                if !is_object_id(value) {
                    return Err(invalid("invalid branch object id"));
                }
                head = Some(String::from_utf8_lossy(value).into_owned());
            }
            continue;
        }
        if let Some(value) = record.strip_prefix(b"# branch.head ") {
            if saw_branch || value.is_empty() {
                return Err(invalid("missing or duplicate branch name"));
            }
            saw_branch = true;
            if value != b"(detached)" {
                branch = Some(String::from_utf8_lossy(value).into_owned());
            }
            continue;
        }
        if record.starts_with(b"# ") {
            // Porcelain v2 explicitly allows new headers without a format version change.
            continue;
        }

        let path = match record.first() {
            Some(b'1') => {
                let (fields, path) = fields::<8>(record)?;
                if fields[0] != b"1" {
                    return Err(invalid("unknown entry type"));
                }
                validate_tracked(&fields, false)?;
                path
            }
            Some(b'2') => {
                let (fields, path) = fields::<9>(record)?;
                if fields[0] != b"2" {
                    return Err(invalid("unknown entry type"));
                }
                validate_tracked(&fields, false)?;
                let score = fields[8];
                if score.len() < 2
                    || !b"RC".contains(&score[0])
                    || !score[1..].iter().all(u8::is_ascii_digit)
                    || std::str::from_utf8(&score[1..])
                        .ok()
                        .and_then(|score| score.parse::<u8>().ok())
                        .is_none_or(|score| score > 100)
                {
                    return Err(invalid("invalid rename/copy score"));
                }
                let original = records
                    .next()
                    .filter(|path| !path.is_empty())
                    .ok_or_else(|| invalid("missing rename/copy source"))?;
                paths.push(String::from_utf8_lossy(path).into_owned());
                // Consume this field as bytes even when its filename resembles a header or entry.
                paths.push(String::from_utf8_lossy(original).into_owned());
                dirty_count = dirty_count
                    .checked_add(1)
                    .ok_or_else(|| invalid("too many entries"))?;
                continue;
            }
            Some(b'u') => {
                let (fields, path) = fields::<10>(record)?;
                if fields[0] != b"u" {
                    return Err(invalid("unknown entry type"));
                }
                validate_tracked(&fields, true)?;
                path
            }
            Some(b'?') => record
                .strip_prefix(b"? ")
                .filter(|path| !path.is_empty())
                .ok_or_else(|| invalid("invalid untracked entry"))?,
            Some(b'!') => {
                if record
                    .strip_prefix(b"! ")
                    .is_none_or(|path| path.is_empty())
                {
                    return Err(invalid("invalid ignored entry"));
                }
                continue;
            }
            _ => return Err(invalid("unknown entry type")),
        };
        paths.push(String::from_utf8_lossy(path).into_owned());
        dirty_count = dirty_count
            .checked_add(1)
            .ok_or_else(|| invalid("too many entries"))?;
    }

    if !saw_head || !saw_branch {
        return Err(invalid("missing branch headers"));
    }
    Ok(WorktreeState {
        head,
        branch,
        dirty_count,
        status_fingerprint: format!("{:x}", Sha256::digest(output)),
        paths,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const OID: &str = "0123456789abcdef0123456789abcdef01234567";

    fn headers() -> String {
        format!("# branch.oid {OID}\0# branch.head feature/example\0")
    }

    #[test]
    fn reads_unborn_detached_and_sha256_heads() {
        let unborn = parse(b"# branch.oid (initial)\0# branch.head main\0").unwrap();
        assert_eq!(unborn.head, None);
        assert_eq!(unborn.branch.as_deref(), Some("main"));
        assert_eq!(unborn.dirty_count, 0);
        assert!(unborn.paths.is_empty());

        let oid = "a".repeat(64);
        let detached = parse(
            format!("# branch.oid {oid}\0# branch.head (detached)\0# future.header value\0")
                .as_bytes(),
        )
        .unwrap();
        assert_eq!(detached.head.as_deref(), Some(oid.as_str()));
        assert_eq!(detached.branch, None);
    }

    #[test]
    fn parses_mixed_entries_without_splitting_pathnames() {
        let status = format!(
            "{}1 MM N... 100644 100644 100644 {OID} {OID} staged and modified.txt\0\
             2 R. N... 100644 100644 100644 {OID} {OID} R100 new\n文件.txt\0\
             # branch.oid old file.txt\0\
             u UU N... 100644 100644 100644 100644 {OID} {OID} {OID} conflict.txt\0\
             1 .M S.MU 160000 160000 160000 {OID} {OID} submodule\0\
             ?  leading space\tfile\0\
             ! ignored.txt\0",
            headers()
        );
        let state = parse(status.as_bytes()).unwrap();
        assert_eq!(state.head.as_deref(), Some(OID));
        assert_eq!(state.branch.as_deref(), Some("feature/example"));
        assert_eq!(state.dirty_count, 5);
        assert_eq!(
            state.paths,
            [
                "staged and modified.txt",
                "new\n文件.txt",
                "# branch.oid old file.txt",
                "conflict.txt",
                "submodule",
                " leading space\tfile",
            ]
        );
    }

    #[test]
    fn fingerprints_original_bytes_before_lossy_path_decoding() {
        let mut first = headers().into_bytes();
        first.extend_from_slice(b"? file\xff\0");
        let mut second = headers().into_bytes();
        second.extend_from_slice(b"? file\xfe\0");
        let first = parse(&first).unwrap();
        let second = parse(&second).unwrap();
        assert_eq!(first.paths, second.paths);
        assert_ne!(first.status_fingerprint, second.status_fingerprint);
        assert_eq!(first.status_fingerprint.len(), 64);
    }

    #[test]
    fn counts_copies_once() {
        let state = parse(
            format!(
                "{}2 C. N... 100644 100644 100644 {OID} {OID} C75 copy.txt\0source.txt\0",
                headers()
            )
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(state.dirty_count, 1);
        assert_eq!(state.paths, ["copy.txt", "source.txt"]);
    }

    #[test]
    fn rejects_truncated_or_malformed_records() {
        let invalid_records = [
            "? ".to_owned(),
            "1 MM missing-fields".to_owned(),
            format!("2 R. N... 100644 100644 100644 {OID} {OID} R100 new.txt"),
            format!("2 R. N... 100644 100644 100644 {OID} {OID} R101 new.txt\0old.txt"),
            format!("1 MM N... 100644 100644 100644 invalid {OID} file"),
            "unknown record".to_owned(),
            "# branch.oid (initial)".to_owned(),
        ];
        for record in invalid_records {
            let output = format!("{}{record}\0", headers());
            assert_eq!(
                parse(output.as_bytes()).unwrap_err().kind,
                GitReadErrorKind::InvalidOutput,
                "accepted {record:?}"
            );
        }
        for output in [b"".as_slice(), b"# branch.oid (initial)\0", b"? file\0"] {
            assert_eq!(
                parse(output).unwrap_err().kind,
                GitReadErrorKind::InvalidOutput
            );
        }
        assert!(parse(headers().trim_end_matches('\0').as_bytes()).is_err());
    }
}
