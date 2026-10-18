use std::{
    ffi::{OsStr, OsString},
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::{Component, Path, PathBuf, Prefix},
};

use crate::{GitReadError, GitReadErrorKind};

fn variable<'a>(environment: &'a [(OsString, OsString)], name: &str) -> Option<&'a OsStr> {
    environment
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_os_str())
}

/// Match libuv's PATH splitting, including quoted directories containing semicolons. Windows
/// pathnames need not be valid Unicode, so splitting uses UTF-16 without replacement characters.
fn path_entries(value: &OsStr) -> Vec<OsString> {
    let units: Vec<_> = value.encode_wide().collect();
    let mut entries = Vec::new();
    let mut start = 0;
    while start < units.len() {
        let mut end = start;
        if matches!(units[start], 34 | 39) {
            end = units[start + 1..]
                .iter()
                .position(|unit| *unit == units[start])
                .map_or(units.len(), |relative| start + relative + 2);
        }
        while end < units.len() && units[end] != 59 {
            end += 1;
        }
        let mut entry = &units[start..end];
        if entry.first().is_some_and(|unit| matches!(unit, 34 | 39)) {
            entry = &entry[1..];
        }
        if entry.last().is_some_and(|unit| matches!(unit, 34 | 39)) {
            entry = &entry[..entry.len() - 1];
        }
        if !entry.is_empty() {
            entries.push(OsString::from_wide(entry));
        }
        start = end + 1;
    }
    entries
}

fn in_worktree(cwd: &Path, directory: &OsStr) -> PathBuf {
    let directory = Path::new(directory);
    let mut components = directory.components();
    if !directory.has_root()
        && let Some(Component::Prefix(prefix)) = components.next()
        && let Prefix::Disk(drive) = prefix.kind()
        && let Some(Component::Prefix(cwd_prefix)) = cwd.components().next()
        && let Prefix::Disk(cwd_drive) = cwd_prefix.kind()
        && drive.eq_ignore_ascii_case(&cwd_drive)
    {
        // C:tools is relative to the child cwd when both refer to the same drive.
        return cwd.join(components.as_path());
    }
    cwd.join(directory)
}

pub(crate) fn git_executable(
    cwd: &Path,
    environment: &[(OsString, OsString)],
) -> Result<PathBuf, GitReadError> {
    let cwd = std::path::absolute(cwd).map_err(|error| {
        GitReadError::new(
            GitReadErrorKind::Io,
            format!("could not resolve working directory: {error}"),
        )
    })?;
    if !cwd.is_dir() {
        return Err(GitReadError::new(
            GitReadErrorKind::MissingWorktree,
            format!("working directory no longer exists: {}", cwd.display()),
        ));
    }

    // std::process searches the parent's PATH even when the child supplies a different one.
    // Resolve against this snapshot first, then pass an absolute executable to avoid that fallback.
    // For the bare name "git", Windows' current-directory policy depends on this variable's
    // presence, not its value. Reading the OS helper would ignore a Node worker's own snapshot.
    let mut directories = Vec::new();
    if variable(environment, "NODEFAULTCURRENTDIRECTORYINEXEPATH").is_none() {
        directories.push(cwd.clone());
    }
    if let Some(value) = variable(environment, "PATH") {
        directories.extend(
            path_entries(value)
                .into_iter()
                .map(|entry| in_worktree(&cwd, &entry)),
        );
    }
    for directory in directories {
        // execFile/libuv searches native executable formats, without consulting PATHEXT or
        // invoking cmd.exe. A .bat or .cmd shim must not become a shell invocation in the core.
        for filename in ["git.com", "git.exe"] {
            let candidate = directory.join(filename);
            if candidate.is_file()
                && let Ok(absolute) = std::path::absolute(candidate)
            {
                return Ok(absolute);
            }
        }
    }
    Err(GitReadError::new(
        GitReadErrorKind::MissingGit,
        "git executable not found in PATH",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{GitReadOptions, environment, read_worktree_state};
    use std::fs;

    fn executable(directory: &Path, filename: &str) -> PathBuf {
        fs::create_dir_all(directory).unwrap();
        let path = directory.join(filename);
        fs::copy(std::env::current_exe().unwrap(), &path).unwrap();
        path
    }

    fn environment(entries: &[(&str, &OsStr)]) -> Vec<(OsString, OsString)> {
        environment::for_read(
            entries
                .iter()
                .map(|(key, value)| (OsString::from(key), value.to_os_string())),
        )
    }

    #[test]
    fn splits_quoted_windows_path_entries_without_decoding() {
        assert_eq!(
            path_entries(OsStr::new(";\"tools;one\";'tools;two';plain tools;;")),
            ["tools;one", "tools;two", "plain tools"].map(OsString::from)
        );
        let raw = OsString::from_wide(&[b'x' as u16, 0xD800]);
        assert_eq!(path_entries(&raw), [raw]);
    }

    #[test]
    fn uses_worker_path_and_never_searches_the_parent_path() {
        let fixture = tempfile::tempdir().unwrap();
        let cwd = fixture.path().join("worktree");
        fs::create_dir(&cwd).unwrap();
        let selected = executable(&fixture.path().join("worker-bin"), "git.exe");
        let child = environment(&[("Path", selected.parent().unwrap().as_os_str())]);
        assert_eq!(git_executable(&cwd, &child).unwrap(), selected);
        for child in [
            environment(&[]),
            environment(&[("PATH", OsStr::new(""))]),
            environment(&[("PATH", fixture.path().join("missing").as_os_str())]),
        ] {
            assert_eq!(
                git_executable(&cwd, &child).unwrap_err().kind,
                GitReadErrorKind::MissingGit
            );
        }
    }

    #[test]
    fn applies_the_worker_current_directory_policy_and_native_extension_order() {
        let fixture = tempfile::tempdir().unwrap();
        let cwd = fixture.path().join("worktree");
        let local = executable(&cwd, "git.exe");
        let chosen = executable(&fixture.path().join("worker-bin"), "git.exe");
        let path = chosen.parent().unwrap().as_os_str();
        assert_eq!(
            git_executable(&cwd, &environment(&[("PATH", path)])).unwrap(),
            local
        );
        let child = environment(&[
            ("PATH", path),
            ("NoDefaultCurrentDirectoryInExePath", OsStr::new("")),
        ]);
        assert_eq!(git_executable(&cwd, &child).unwrap(), chosen);
        let com = executable(chosen.parent().unwrap(), "git.com");
        assert_eq!(git_executable(&cwd, &child).unwrap(), com);
        fs::remove_file(com).unwrap();
        fs::remove_file(chosen).unwrap();
        executable(fixture.path().join("worker-bin").as_path(), "git.cmd");
        executable(fixture.path().join("worker-bin").as_path(), "git.bat");
        assert_eq!(
            git_executable(&cwd, &child).unwrap_err().kind,
            GitReadErrorKind::MissingGit
        );
    }

    #[test]
    fn resolves_relative_and_quoted_path_entries_against_the_child_directory() {
        let fixture = tempfile::tempdir().unwrap();
        let cwd = fixture.path().join("worktree");
        let chosen = executable(&cwd.join("local tools"), "git.exe");
        for entry in [
            "local tools",
            "\"local tools\"",
            "'local tools'",
            ";local tools;",
        ] {
            let child = environment(&[("pAtH", OsStr::new(entry))]);
            assert_eq!(git_executable(&cwd, &child).unwrap(), chosen);
        }
        let semicolon = executable(&cwd.join("semi;colon"), "git.exe");
        assert_eq!(
            git_executable(
                &cwd,
                &environment(&[("PATH", OsStr::new("\"semi;colon\""))])
            )
            .unwrap(),
            semicolon
        );
        if let Some(Component::Prefix(prefix)) = cwd.components().next()
            && let Prefix::Disk(drive) = prefix.kind()
        {
            let entry = format!("{}:local tools", drive as char);
            assert_eq!(
                git_executable(&cwd, &environment(&[("PATH", OsStr::new(&entry))])).unwrap(),
                chosen
            );
        }
    }

    #[tokio::test]
    async fn a_read_with_no_worker_path_cannot_run_the_parent_git() {
        let fixture = tempfile::tempdir().unwrap();
        let result = read_worktree_state(
            fixture.path(),
            GitReadOptions {
                environment: Some(Vec::new()),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(result.unwrap_err().kind, GitReadErrorKind::MissingGit);
    }
}
