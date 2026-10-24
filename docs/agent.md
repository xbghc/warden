# Working with agents

Warden creates task workspaces and exposes generic [workspace hooks](worktrees.md#workspace-hooks).
Users run agents and interact with them through their own tools or scripts.

Work happens in the assigned task worktree. The user runs tests in the preview directory and reviews
changes before squash. Warden does not require an agent test command, structured delivery report or
readiness signal.

Default task workspaces are numbered directories beside primary and share Warden's external Git
repository with the preview. Each workspace has its own files, HEAD and index; agent edits and
commits belong only in the assigned task workspace. The user edits primary and runs the combined
code in preview. Ordinary agent commits retain their Git hooks and signing; Warden's temporary
composition commands do not change that configuration. Independent clones remain available for
tools that cannot use linked worktrees.

## Task briefs

Plan and order small changes in the left navigation. Allocate a workspace when needed, then copy
its task brief to the assigned agent. The brief includes the task title, goal, acceptance notes,
assignment, workspace path, development branch and development instructions.

Copying a brief only writes text to the clipboard. It does not launch an agent or update review state.
Review feedback is exchanged through the user's own tools. In a native Warden diff, select a line
or range and run **Warden: 复制审阅位置** (`Ctrl+Alt+C`, macOS `Cmd+Alt+C`).

Inline comments, comment exports and the `warden feedback` / `warden reply` commands have been
removed. Historical review fields in existing state files are retained as opaque data on unrelated
writes; they are no longer displayed, reanchored, replied to or copied into briefs.

Existing TODO text and historical metadata migrate without inventing completed commits. Old
checked items are archived; notes on unrelated branches remain available for explicit import.
See [Worktrees and tasks](worktrees.md#development-workflow).
