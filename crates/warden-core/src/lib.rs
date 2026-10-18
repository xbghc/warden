//! Repository operations without a dependency on Node, HTTP, or Warden's state store.
//!
//! Each status read asks Git for branch, commit, and worktree state together. Keeping this
//! boundary independent lets callers compare Git-backed operations with future native readers
//! without changing their public model or relying on cached answers after external Git edits.

mod environment;
mod error;
mod git;
mod status;
#[cfg(windows)]
mod windows;

use std::{ffi::OsString, path::Path, time::Duration};

pub use error::{GitReadError, GitReadErrorKind};

/// One observation of a worktree. Files can still change while Git scans the directory.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorktreeState {
    /// The current commit, or `None` before the first commit.
    pub head: Option<String>,
    /// The short branch name, or `None` when HEAD is detached.
    pub branch: Option<String>,
    /// Changed entries, counting a rename once and excluding ignored files.
    pub dirty_count: u32,
    /// SHA-256 of the exact status bytes, including branch and index metadata.
    pub status_fingerprint: String,
    /// Repository-relative changed paths. Renames include the destination and source.
    /// Non-UTF-8 paths use replacement characters, matching Node's UTF-8 decoding.
    pub paths: Vec<String>,
}

/// Resource limits and the environment used for one read.
#[derive(Clone, Debug)]
pub struct GitReadOptions {
    /// Includes time spent waiting for the shared process limit.
    pub timeout: Duration,
    /// Maximum bytes retained from each of stdout and stderr.
    pub max_output_bytes: usize,
    /// Callers with their own environment (such as a Node worker) pass a snapshot here.
    /// Repository-local Git variables are removed even from an explicit snapshot.
    /// On Windows, an absent or empty PATH never falls back to the parent process's PATH.
    pub environment: Option<Vec<(OsString, OsString)>>,
}

impl Default for GitReadOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(30),
            max_output_bytes: 256 * 1024 * 1024,
            environment: None,
        }
    }
}

/// Read a worktree using one read-only Git process, with at most eight reads running at once.
///
/// This does not cache completed results: agents and ordinary Git commands can change the
/// repository without going through Warden. No shell is used and the real index is not refreshed.
pub async fn read_worktree_state(
    cwd: impl AsRef<Path>,
    options: GitReadOptions,
) -> Result<WorktreeState, GitReadError> {
    let output = git::read_status(cwd.as_ref(), options).await?;
    status::parse(&output.stdout).map_err(|error| error.with_output(&output.stderr, Some(0)))
}
