# Platform

## Windows, Linux and macOS

Warden runs in the VS Code workspace extension host. Git must be installed in that environment.
The packaged extension includes Node code and tested Rust bindings for Linux x64/arm64 with glibc,
macOS x64/arm64, and Windows x64. Unsupported native targets use the existing Git compatibility
backend; an installed but unloadable artifact is reported as a packaging error.

Workspace scripts use a POSIX shell. Git for Windows supplies it on Windows. Script-specific tools
must be installed by the user. Preview terminals and tasks inherit the workspace runtime environment.
Pure browser virtual workspaces are unsupported because Warden needs Git processes and real worktrees.

## WSL2 notes

Install Warden into the WSL workspace extension host and open the Linux primary directory through
VS Code Remote WSL. Git, task workspaces, preview files and scripts run inside WSL. There is no browser
server, localhost probing or Windows port handoff. Remote SSH and Dev Containers follow the same
placement rule: execution and repository state stay beside the workspace.

Do not add the generated preview directory as an editor workspace root. Use its path for user-owned
terminal, task and debug configurations. Closing the last Warden window pauses preview synchronization;
reopening checks state and resumes it. Warden does not manage external agent or development-server processes.
