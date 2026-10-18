use std::{io, path::Path, process::Stdio, time::Duration};

use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, ChildStderr, Command},
    sync::Semaphore,
    time::{Instant, timeout_at},
};

use crate::{GitReadError, GitReadErrorKind, GitReadOptions, environment};

// A batch of many slots must not create an unbounded process burst. The limit is shared by all
// consumers in this process, including callers using different Tokio runtimes.
static STATUS_SLOTS: Semaphore = Semaphore::const_new(8);

const STATUS_ARGS: &[&str] = &[
    "status",
    "--porcelain=v2",
    "--branch",
    "--untracked-files=all",
    "--no-ahead-behind",
    "-z",
];

enum ProcessFailure {
    Wait(io::Error),
    Read(&'static str, io::Error),
    Limit(&'static str),
}

#[derive(Debug)]
pub(crate) struct GitOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

async fn read_limited(
    reader: &mut (impl AsyncRead + Unpin),
    output: &mut Vec<u8>,
    limit: usize,
    stream: &'static str,
) -> Result<(), ProcessFailure> {
    let mut buffer = [0u8; 8192];
    loop {
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(|error| ProcessFailure::Read(stream, error))?;
        if count == 0 {
            return Ok(());
        }
        let remaining = limit.saturating_sub(output.len());
        output.extend_from_slice(&buffer[..count.min(remaining)]);
        if count > remaining {
            return Err(ProcessFailure::Limit(stream));
        }
    }
}

fn spawn_error(error: io::Error, cwd: &Path) -> GitReadError {
    if error.kind() == io::ErrorKind::NotADirectory
        || (error.kind() == io::ErrorKind::NotFound && !cwd.exists())
    {
        return GitReadError::new(
            GitReadErrorKind::MissingWorktree,
            format!("working directory no longer exists: {}", cwd.display()),
        );
    }
    if error.kind() == io::ErrorKind::NotFound {
        return GitReadError::new(
            GitReadErrorKind::MissingGit,
            "git executable not found in PATH",
        );
    }
    GitReadError::new(
        GitReadErrorKind::Io,
        format!("could not start git: {error}"),
    )
}

async fn stop_and_drain(
    child: &mut Child,
    stderr: &mut ChildStderr,
    errors: &mut Vec<u8>,
    limit: usize,
) {
    // Reap the process before callers remove fixture or workspace directories. A Git helper can
    // inherit a pipe, so draining its remaining diagnostics must have its own short deadline.
    let _ = child.start_kill();
    let _ = child.wait().await;
    let _ = tokio::time::timeout(
        Duration::from_millis(100),
        read_limited(stderr, errors, limit, "stderr"),
    )
    .await;
}

pub(crate) async fn read_status(
    cwd: &Path,
    options: GitReadOptions,
) -> Result<GitOutput, GitReadError> {
    let deadline = Instant::now() + options.timeout;
    let environment = environment::for_read(
        options
            .environment
            .unwrap_or_else(|| std::env::vars_os().collect()),
    );
    let _permit = timeout_at(deadline, STATUS_SLOTS.acquire())
        .await
        .map_err(|_| GitReadError::new(GitReadErrorKind::Timeout, "git status timed out"))?
        .map_err(|_| GitReadError::new(GitReadErrorKind::Io, "git status process limit closed"))?;

    #[cfg(windows)]
    let executable = crate::windows::git_executable(cwd, &environment)?;
    #[cfg(not(windows))]
    let executable = "git";
    let mut command = Command::new(executable);
    command
        .args(STATUS_ARGS)
        .current_dir(cwd)
        .env_clear()
        .envs(environment)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x08000000);
    }
    collect(command, cwd, deadline, options.max_output_bytes).await
}

async fn collect(
    mut command: Command,
    cwd: &Path,
    deadline: Instant,
    limit: usize,
) -> Result<GitOutput, GitReadError> {
    let mut child = command.spawn().map_err(|error| spawn_error(error, cwd))?;
    let mut stdout = child.stdout.take().expect("stdout is piped");
    let mut stderr = child.stderr.take().expect("stderr is piped");
    let mut output = Vec::new();
    let mut errors = Vec::new();
    let result = timeout_at(deadline, async {
        tokio::try_join!(
            async { child.wait().await.map_err(ProcessFailure::Wait) },
            read_limited(&mut stdout, &mut output, limit, "stdout"),
            read_limited(&mut stderr, &mut errors, limit, "stderr"),
        )
    })
    .await;

    match result {
        Ok(Ok((status, (), ()))) if status.success() => Ok(GitOutput {
            stdout: output,
            stderr: errors,
        }),
        Ok(Ok((status, (), ()))) => {
            let message = String::from_utf8_lossy(&errors)
                .trim()
                .lines()
                .next()
                .filter(|line| !line.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("git status failed: {status}"));
            Err(GitReadError::new(GitReadErrorKind::Failed, message)
                .with_output(&errors, status.code()))
        }
        Err(_) => {
            stop_and_drain(&mut child, &mut stderr, &mut errors, limit).await;
            Err(
                GitReadError::new(GitReadErrorKind::Timeout, "git status timed out")
                    .with_output(&errors, None),
            )
        }
        Ok(Err(failure)) => {
            stop_and_drain(&mut child, &mut stderr, &mut errors, limit).await;
            let (kind, message) = match failure {
                ProcessFailure::Limit(stream) => (
                    GitReadErrorKind::OutputLimit,
                    format!("git status {stream} exceeded {limit} bytes"),
                ),
                ProcessFailure::Read(stream, error) => (
                    GitReadErrorKind::Io,
                    format!("could not read git status {stream}: {error}"),
                ),
                ProcessFailure::Wait(error) => (
                    GitReadErrorKind::Io,
                    format!("could not wait for git status: {error}"),
                ),
            };
            Err(GitReadError::new(kind, message).with_output(&errors, None))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bounds_each_stream_without_reading_it_to_completion() {
        let mut reader = &b"too much output"[..];
        let mut output = Vec::new();
        assert!(matches!(
            read_limited(&mut reader, &mut output, 3, "stdout").await,
            Err(ProcessFailure::Limit("stdout"))
        ));
        assert_eq!(output, b"too");
    }

    #[test]
    fn distinguishes_missing_directory_from_missing_git() {
        let existing = tempfile::tempdir().unwrap();
        let missing = existing.path().join("deleted");
        assert_eq!(
            spawn_error(io::ErrorKind::NotFound.into(), &missing).kind,
            GitReadErrorKind::MissingWorktree
        );
        assert_eq!(
            spawn_error(io::ErrorKind::NotFound.into(), existing.path()).kind,
            GitReadErrorKind::MissingGit
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kills_and_reaps_a_timed_out_child_with_partial_stderr() {
        let fixture = tempfile::tempdir().unwrap();
        let pid_file = fixture.path().join("pid");
        let mut command = Command::new("sh");
        command
            .args([
                "-c",
                "echo $$ > \"$1\"; echo stalled >&2; exec sleep 30",
                "sh",
            ])
            .arg(&pid_file)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let result = collect(
            command,
            fixture.path(),
            Instant::now() + Duration::from_millis(250),
            1024,
        )
        .await
        .unwrap_err();
        assert_eq!(result.kind, GitReadErrorKind::Timeout);
        assert_eq!(result.stderr, "stalled\n");
        let pid = std::fs::read_to_string(pid_file).unwrap();
        let alive = std::process::Command::new("kill")
            .args(["-0", pid.trim()])
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(!alive.success(), "timed-out process was left running");
    }
}
