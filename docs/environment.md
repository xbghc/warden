# Platform

## Windows, Linux and macOS

Install Node.js 20 or newer and Git, with both available on `PATH`. Native Windows uses Git for
Windows. Repository paths may contain spaces or Unicode; target keys accept Windows drive paths,
UNC paths and POSIX absolute paths.

Workspace `create` and `reuse` hooks use POSIX shell syntax on every platform. Linux and macOS run
`/bin/sh`; Windows locates the `sh.exe` bundled with Git for Windows, including portable installs.
Missing shell support is reported as a failed hook and leaves the workspace available for retry.
Use the provided `WARDEN_*` variables to identify the repository and task; quote path arguments.

The optional tmux command interface requires tmux in the environment where Warden runs. On Windows,
run Warden inside WSL2 when using tmux; the native Git review and workspace flows do not require it.

The complete automated suite is a release gate on all three operating systems. See
[Development](development.md#building-and-testing) for the Node matrix and test isolation rules.

## WSL2 notes

- Access the UI from the Windows browser at the printed `http://127.0.0.1:<port>/` URL; WSL2 forwards
  localhost automatically.
- Install [wslu](https://github.com/wslutilities/wslu) for `wslview` if `explorer.exe` doesn't open the
  URL for you, or run with `--no-open`.
- Keep the repository on the Linux filesystem for reasonable git performance.
- Clipboard access uses `navigator.clipboard`, which works on `localhost`; if you expose the port via
  another hostname the copy button falls back to `document.execCommand('copy')`.
