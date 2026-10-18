use std::{error::Error, fmt};

/// Errors are independent of the transport; adapters choose HTTP or Node error conventions.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitReadErrorKind {
    Timeout,
    MissingGit,
    MissingWorktree,
    Failed,
    InvalidOutput,
    OutputLimit,
    Io,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitReadError {
    pub kind: GitReadErrorKind,
    pub message: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

impl GitReadError {
    pub(crate) fn new(kind: GitReadErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            stderr: String::new(),
            exit_code: None,
        }
    }

    pub(crate) fn with_output(mut self, stderr: &[u8], exit_code: Option<i32>) -> Self {
        self.stderr = String::from_utf8_lossy(stderr).into_owned();
        self.exit_code = exit_code;
        self
    }
}

impl fmt::Display for GitReadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for GitReadError {}
