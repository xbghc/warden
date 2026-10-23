# Working with agents

Warden creates task workspaces and exposes generic [workspace hooks](worktrees.md#workspace-hooks).
Users run agents and interact with them through their own tools or scripts.

Work happens in the assigned task worktree. The user runs tests in the preview directory and reviews
changes before squash. Warden does not require an agent test command, structured delivery report or
readiness signal.

## Task briefs

Plan and order small changes in the left navigation. Allocate a workspace when needed, then copy
its task brief to the assigned agent. The brief includes the task title, goal, acceptance notes,
assignment, workspace path, development branch and development instructions.

Copying a brief only writes text to the clipboard. It does not launch an agent, update review state
or take a checkpoint. Review feedback is exchanged through the user's own tools. Click a diff line
number to copy its location; Shift-click extends the copied range on the same side.

Inline comments, comment exports and the `warden feedback` / `warden reply` commands have been
removed. Historical review fields in existing state files are retained as opaque data on unrelated
writes; they are no longer displayed, reanchored, replied to or copied into briefs.

Existing TODO text and historical metadata migrate without inventing completed commits. Old
checked items are archived; notes on unrelated branches remain available for explicit import.
See [Worktrees and tasks](worktrees.md#development-workflow).
