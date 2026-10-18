use std::ffi::{OsStr, OsString};

// Keep this list aligned with packages/server/src/git.ts. A server started by a Git hook must
// inspect its validated worktree, while retaining normal user/system Git configuration.
const REPOSITORY_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_QUARANTINE_PATH",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
    "GIT_SUPER_PREFIX",
    "GIT_INTERNAL_SUPER_PREFIX",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_GRAFT_FILE",
    "GIT_SHALLOW_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
];

const READ_ENV: &[(&str, &str)] = &[
    ("LC_ALL", "C"),
    ("GIT_PAGER", "cat"),
    ("PAGER", "cat"),
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GIT_OPTIONAL_LOCKS", "0"),
];

fn should_remove(key: &OsStr) -> bool {
    let Some(key) = key.to_str() else {
        return false;
    };
    let key = key.to_ascii_uppercase();
    if REPOSITORY_ENV.contains(&key.as_str()) || READ_ENV.iter().any(|(name, _)| *name == key) {
        return true;
    }
    key.strip_prefix("GIT_CONFIG_KEY_")
        .or_else(|| key.strip_prefix("GIT_CONFIG_VALUE_"))
        .is_some_and(|suffix| {
            !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
        })
}

pub(crate) fn for_read(
    environment: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    let clean: Vec<_> = environment
        .into_iter()
        .filter(|(key, _)| !should_remove(key))
        .chain(
            READ_ENV
                .iter()
                .map(|(key, value)| (OsString::from(key), OsString::from(value))),
        )
        .collect();
    #[cfg(windows)]
    {
        // Node sorts environment keys and keeps the first case-insensitive occurrence. Worker
        // snapshots can contain both PATH and Path; do not let a binding's map iteration choose.
        let mut clean = clean;
        clean.sort_by(|(left, _), (right, _)| left.cmp(right));
        let mut seen = std::collections::HashSet::new();
        clean.retain(|(key, _)| seen.insert(key.to_ascii_uppercase()));
        clean
    }
    #[cfg(not(windows))]
    {
        clean
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn strips_repository_overrides_case_insensitively() {
        let mut entries = REPOSITORY_ENV
            .iter()
            .map(|key| {
                (
                    OsString::from(key.to_ascii_lowercase()),
                    OsString::from("bad"),
                )
            })
            .collect::<Vec<_>>();
        entries.extend([
            ("gIt_CoNfIg_KeY_123".into(), "core.bare".into()),
            ("git_config_value_123".into(), "true".into()),
        ]);
        let clean = for_read(entries);
        assert_eq!(clean.len(), READ_ENV.len());
    }

    #[test]
    fn preserves_regular_configuration_and_replaces_read_controls() {
        let input = [
            ("PATH", "/usr/bin"),
            ("HOME", "/home/example"),
            ("GIT_CONFIG_GLOBAL", "/tmp/gitconfig"),
            ("GIT_CONFIG_SYSTEM", "/tmp/system-gitconfig"),
            ("GIT_CONFIG_NOSYSTEM", "1"),
            ("GIT_AUTHOR_NAME", "Example"),
            ("GIT_CONFIG_KEY_TEXT", "retain"),
            ("GIT_CONFIG_VALUE_", "retain"),
            ("git_optional_locks", "1"),
            ("git_pager", "unsafe-pager"),
            ("LC_ALL", "en_US.UTF-8"),
        ];
        let clean: HashMap<_, _> = for_read(
            input
                .into_iter()
                .map(|(key, value)| (OsString::from(key), OsString::from(value))),
        )
        .into_iter()
        .collect();
        for (key, value) in input.into_iter().take(8) {
            assert_eq!(clean.get(OsStr::new(key)), Some(&OsString::from(value)));
        }
        for (key, value) in READ_ENV {
            assert_eq!(clean.get(OsStr::new(key)), Some(&OsString::from(value)));
        }
        assert!(!clean.contains_key(OsStr::new("git_optional_locks")));
        assert!(!clean.contains_key(OsStr::new("git_pager")));
    }

    #[cfg(windows)]
    #[test]
    fn uses_the_same_case_insensitive_first_key_as_node() {
        let input = [("path", "third"), ("Path", "second"), ("PATH", "first")];
        let clean = for_read(
            input
                .into_iter()
                .map(|(key, value)| (key.into(), value.into())),
        );
        let paths: Vec<_> = clean
            .iter()
            .filter(|(key, _)| key.eq_ignore_ascii_case("PATH"))
            .collect();
        assert_eq!(paths, [&(OsString::from("PATH"), OsString::from("first"))]);
    }
}
