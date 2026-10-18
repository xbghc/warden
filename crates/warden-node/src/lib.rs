use std::{collections::HashMap, path::Path, sync::Once};

use napi::bindgen_prelude::create_custom_tokio_runtime;
use napi_derive::napi;
use warden_core::{GitReadErrorKind, GitReadOptions};

#[napi_derive::module_init]
fn initialize_runtime() {
    static INITIALIZE: Once = Once::new();
    INITIALIZE.call_once(|| {
        // Git performs the expensive work in child processes. A small I/O runtime avoids
        // adding one worker per CPU to the Node process that also launches those children.
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("warden-git")
            .enable_all()
            .build()
            .expect("Create Warden Git runtime failed");
        create_custom_tokio_runtime(runtime);
    });
}

#[napi(object)]
pub struct WorktreeState {
    pub head: Option<String>,
    pub branch: Option<String>,
    pub dirty_count: u32,
    pub status_fingerprint: String,
    pub paths: Vec<String>,
}

#[napi(object)]
pub struct GitReadError {
    pub kind: String,
    pub message: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

#[napi(object)]
pub struct WorktreeReadResult {
    pub state: Option<WorktreeState>,
    pub error: Option<GitReadError>,
}

// Node workers may have their own process.env. Pass that snapshot explicitly; Rust's process
// environment cannot observe worker-local changes made by the server or its test fixtures.
#[napi]
pub async fn read_worktree_state(
    path: String,
    environment: HashMap<String, String>,
) -> napi::Result<WorktreeReadResult> {
    let options = GitReadOptions {
        environment: Some(
            environment
                .into_iter()
                .map(|(key, value)| (key.into(), value.into()))
                .collect(),
        ),
        ..GitReadOptions::default()
    };
    Ok(
        match warden_core::read_worktree_state(Path::new(&path), options).await {
            Ok(state) => WorktreeReadResult {
                state: Some(WorktreeState {
                    head: state.head,
                    branch: state.branch,
                    dirty_count: state.dirty_count,
                    status_fingerprint: state.status_fingerprint,
                    paths: state.paths,
                }),
                error: None,
            },
            Err(error) => WorktreeReadResult {
                state: None,
                error: Some(GitReadError {
                    kind: match error.kind {
                        GitReadErrorKind::Timeout => "timeout",
                        GitReadErrorKind::MissingGit => "missing_git",
                        GitReadErrorKind::MissingWorktree => "missing_worktree",
                        GitReadErrorKind::Failed => "failed",
                        GitReadErrorKind::InvalidOutput => "invalid_output",
                        GitReadErrorKind::OutputLimit => "output_limit",
                        GitReadErrorKind::Io => "io",
                    }
                    .into(),
                    message: error.message,
                    stderr: error.stderr,
                    exit_code: error.exit_code,
                }),
            },
        },
    )
}
