use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

use tempfile::TempDir;
use warden_core::{GitReadErrorKind, GitReadOptions, WorktreeState, read_worktree_state};

struct Fixture {
    directory: TempDir,
    root: PathBuf,
    environment: Vec<(OsString, OsString)>,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("repository");
        let global_config = directory.path().join("global-gitconfig");
        fs::create_dir(&root).unwrap();
        fs::write(&global_config, "").unwrap();
        let mut environment: Vec<_> = std::env::vars_os()
            .filter(|(name, _)| {
                !name
                    .to_string_lossy()
                    .to_ascii_uppercase()
                    .starts_with("GIT_")
            })
            .collect();
        environment.extend([
            ("GIT_CONFIG_GLOBAL".into(), global_config.into_os_string()),
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
            ("GIT_AUTHOR_NAME".into(), "Warden Core Test".into()),
            (
                "GIT_AUTHOR_EMAIL".into(),
                "warden-test@example.invalid".into(),
            ),
            ("GIT_COMMITTER_NAME".into(), "Warden Core Test".into()),
            (
                "GIT_COMMITTER_EMAIL".into(),
                "warden-test@example.invalid".into(),
            ),
            ("LC_ALL".into(), "C".into()),
            ("GIT_TERMINAL_PROMPT".into(), "0".into()),
        ]);
        let fixture = Self {
            directory,
            root,
            environment,
        };
        fixture.git(&["init", "--initial-branch=main", "--template="]);
        fixture.git(&["config", "commit.gpgsign", "false"]);
        fixture.git(&["config", "core.autocrlf", "false"]);
        fixture
    }

    fn command(&self, cwd: &Path, args: &[&str]) -> Output {
        Command::new("git")
            .current_dir(cwd)
            .args(args)
            .env_clear()
            .envs(self.environment.iter().cloned())
            .output()
            .unwrap()
    }

    fn git(&self, args: &[&str]) -> String {
        let output = self.command(&self.root, args);
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    fn write(&self, path: &str, content: &str) {
        let path = self.root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn options(&self) -> GitReadOptions {
        GitReadOptions {
            environment: Some(self.environment.clone()),
            ..Default::default()
        }
    }

    async fn state(&self) -> WorktreeState {
        read_worktree_state(&self.root, self.options())
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn observes_external_changes_partial_staging_and_renames_without_writing_index() {
    let fixture = Fixture::new();
    let initial = fixture.state().await;
    assert_eq!(initial.head, None);
    assert_eq!(initial.branch.as_deref(), Some("main"));
    assert_eq!(initial.dirty_count, 0);
    fixture.write("old name.txt", "base\n");
    fixture.write("partially staged.txt", "base\n");
    fixture.write(".gitignore", "ignored/\n");
    fixture.git(&["add", "--all"]);
    fixture.git(&["commit", "-m", "Initial"]);
    let head = fixture.git(&["rev-parse", "HEAD"]);
    let clean = fixture.state().await;
    assert_eq!(clean.head.as_deref(), Some(head.as_str()));
    assert_eq!(clean.dirty_count, 0);

    fixture.git(&["mv", "old name.txt", "new 文件.txt"]);
    fixture.write("partially staged.txt", "staged\n");
    fixture.git(&["add", "partially staged.txt"]);
    fixture.write("partially staged.txt", "working\n");
    fixture.write("untracked/nested file.txt", "new\n");
    fixture.write("ignored/file.txt", "not counted\n");
    let index = fixture.root.join(".git/index");
    let index_bytes = fs::read(&index).unwrap();
    let index_modified = fs::metadata(&index).unwrap().modified().unwrap();
    let dirty = fixture.state().await;
    assert_eq!(dirty.dirty_count, 3);
    assert_eq!(dirty.head, clean.head);
    assert!(dirty.paths.contains(&"new 文件.txt".to_owned()));
    assert!(dirty.paths.contains(&"old name.txt".to_owned()));
    assert!(dirty.paths.contains(&"partially staged.txt".to_owned()));
    assert!(
        dirty
            .paths
            .contains(&"untracked/nested file.txt".to_owned())
    );
    assert_eq!(dirty.paths.len(), 4);
    assert_ne!(dirty.status_fingerprint, clean.status_fingerprint);
    assert_eq!(fs::read(&index).unwrap(), index_bytes);
    assert_eq!(
        fs::metadata(&index).unwrap().modified().unwrap(),
        index_modified
    );

    fixture.git(&["add", "--all"]);
    fixture.git(&["commit", "-m", "External commit"]);
    let committed = fixture.state().await;
    assert_eq!(committed.dirty_count, 0);
    assert_ne!(committed.head, dirty.head);
    fixture.git(&["checkout", "--detach"]);
    assert_eq!(fixture.state().await.branch, None);
}

#[tokio::test]
async fn reads_linked_worktrees_and_clones_in_their_own_repository() {
    let fixture = Fixture::new();
    fixture.write("file.txt", "base\n");
    fixture.git(&["add", "--all"]);
    fixture.git(&["commit", "-m", "Initial"]);
    let linked = fixture.directory.path().join("linked workspace");
    fixture.git(&["worktree", "add", "-b", "linked", linked.to_str().unwrap()]);
    fs::write(linked.join("file.txt"), "linked edit\n").unwrap();
    let state = read_worktree_state(&linked, fixture.options())
        .await
        .unwrap();
    assert_eq!(state.branch.as_deref(), Some("linked"));
    assert_eq!(state.dirty_count, 1);
    assert_eq!(fixture.state().await.dirty_count, 0);

    let clone = fixture.directory.path().join("clone workspace");
    fixture.git(&[
        "clone",
        "--no-hardlinks",
        fixture.root.to_str().unwrap(),
        clone.to_str().unwrap(),
    ]);
    fs::write(clone.join("untracked.txt"), "clone edit\n").unwrap();
    let state = read_worktree_state(&clone, fixture.options())
        .await
        .unwrap();
    assert_eq!(state.branch.as_deref(), Some("main"));
    assert_eq!(state.dirty_count, 1);
    assert_eq!(state.paths, ["untracked.txt"]);
}

#[tokio::test]
async fn counts_an_unmerged_path_once() {
    let fixture = Fixture::new();
    fixture.write("file.txt", "base\n");
    fixture.git(&["add", "--all"]);
    fixture.git(&["commit", "-m", "Initial"]);
    fixture.git(&["checkout", "-b", "side"]);
    fixture.write("file.txt", "side\n");
    fixture.git(&["commit", "-am", "Side"]);
    fixture.git(&["checkout", "main"]);
    fixture.write("file.txt", "main\n");
    fixture.git(&["commit", "-am", "Main"]);
    assert!(
        !fixture
            .command(&fixture.root, &["merge", "side"])
            .status
            .success()
    );
    let state = fixture.state().await;
    assert_eq!(state.dirty_count, 1);
    assert_eq!(state.paths, ["file.txt"]);
}

#[tokio::test]
async fn sanitizes_explicit_hook_environment_and_keeps_user_configuration() {
    let fixture = Fixture::new();
    let other = Fixture::new();
    other.write("other.txt", "other repository\n");
    other.git(&["add", "--all"]);
    other.git(&["commit", "-m", "Other"]);
    let excludes = fixture.directory.path().join("global-ignore");
    fs::write(&excludes, "ignored-globally.txt\n").unwrap();
    fixture.git(&[
        "config",
        "--global",
        "core.excludesFile",
        excludes.to_str().unwrap(),
    ]);
    fixture.write("visible.txt", "visible\n");
    fixture.write("ignored-globally.txt", "ignored\n");

    let mut options = fixture.options();
    options.environment.as_mut().unwrap().extend([
        ("GIT_DIR".into(), other.root.join(".git").into_os_string()),
        ("git_work_tree".into(), other.root.as_os_str().to_owned()),
        (
            "GIT_INDEX_FILE".into(),
            other.root.join(".git/index").into_os_string(),
        ),
        ("GIT_CONFIG_COUNT".into(), "1".into()),
        ("GIT_CONFIG_KEY_0".into(), "core.bare".into()),
        ("GIT_CONFIG_VALUE_0".into(), "true".into()),
    ]);
    let state = read_worktree_state(&fixture.root, options).await.unwrap();
    assert_eq!(state.head, None);
    assert_eq!(state.branch.as_deref(), Some("main"));
    assert_eq!(state.paths, ["visible.txt"]);
}

#[tokio::test]
async fn reports_git_failure_and_deleted_worktrees_without_losing_diagnostics() {
    let directory = tempfile::tempdir().unwrap();
    let failed = read_worktree_state(directory.path(), GitReadOptions::default())
        .await
        .unwrap_err();
    assert_eq!(failed.kind, GitReadErrorKind::Failed);
    assert_eq!(failed.exit_code, Some(128));
    assert!(!failed.stderr.is_empty());
    let missing = read_worktree_state(directory.path().join("deleted"), GitReadOptions::default())
        .await
        .unwrap_err();
    assert_eq!(missing.kind, GitReadErrorKind::MissingWorktree);
}

#[tokio::test]
async fn stops_when_status_exceeds_the_output_limit() {
    let fixture = Fixture::new();
    let error = read_worktree_state(
        &fixture.root,
        GitReadOptions {
            max_output_bytes: 10,
            ..fixture.options()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.kind, GitReadErrorKind::OutputLimit);
}

#[cfg(unix)]
#[tokio::test]
async fn retains_newline_and_non_utf8_path_boundaries() {
    use std::os::unix::ffi::OsStringExt;

    let fixture = Fixture::new();
    fixture.write("line\nbreak.txt", "new\n");
    fs::write(
        fixture
            .root
            .join(OsString::from_vec(b"raw\xff.txt".to_vec())),
        "new\n",
    )
    .unwrap();
    let state = fixture.state().await;
    assert_eq!(state.dirty_count, 2);
    assert!(state.paths.contains(&"line\nbreak.txt".to_owned()));
    assert!(state.paths.contains(&"raw\u{fffd}.txt".to_owned()));
}
