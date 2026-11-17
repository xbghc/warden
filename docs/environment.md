# Platform

## Windows, Linux and macOS

Warden runs in the VS Code workspace extension host. Git must be installed in that environment.
The packaged extension contains bundled JavaScript and runs repository operations through Git CLI.
It needs no native addons, platform-specific Warden binaries or separate language runtime.
CI tests the engine on Linux and macOS x64/arm64 and Windows x64, and the packaged extension on
Windows, Linux and macOS.

Workspace scripts use a POSIX shell. Git for Windows supplies it on Windows. Script-specific tools
must be installed by the user. Terminals and tasks in the work folder inherit the workspace runtime environment.
Pure browser virtual workspaces are unsupported because Warden needs Git processes and real worktrees.

## WSL2 notes

Install Warden into the WSL workspace extension host and open the Linux primary directory through
VS Code Remote WSL. Git, task workspaces, the work folder and scripts run inside WSL. There is no browser
server, localhost probing or Windows port handoff. Remote SSH and Dev Containers follow the same
placement rule: execution and repository state stay beside the workspace.

Open the work folder, `<primary>-work`, as the window's folder and keep terminal, task and debug
configurations there. Closing the last Warden window pauses work folder synchronization;
reopening checks state and resumes it. Warden does not manage external agent or development-server processes.
