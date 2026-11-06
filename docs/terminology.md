# Terminology

This is the naming contract for Warden's interface, documentation and new code. The
[workflow](workflow.md) defines behavior. Warden-owned interface copy uses English, including
commands, tooltips, status labels, empty states, settings, errors and conversation controls.
Task content, branch names, paths, agent-provided text and Git/script output retain their original
language and spelling. Changing the interface language does not translate saved user content.

Use standard Git names for Git operations: **Commit**, **Diff** and **Rebase** retain their Git
meanings. Define only Warden-specific roles and conventions here. Action labels specify the
operation and its scope; they do not introduce additional domain concepts.

## Warden roles and conventions

| Interface term | Meaning and boundary |
| --- | --- |
| Base Branch | The explicitly selected local branch for the current work, such as `feature/order`. Task branches start from it, rebase onto it and contribute reviewed commits back to it. This role does not imply the repository's default branch or a permanent parent-child hierarchy. |
| Task / Tasks | One small, linear piece of work identified by its title alone / the ordered task list. Creating a task automatically allocates its workspace. A task can contribute several commits over time; order does not establish dependencies or automatic scheduling. |
| Workbench | Warden's native sidebar containing ordered tasks as top-level items; not an execution directory or lifecycle object. Preview controls use native menus and the status bar. |
| Primary Folder | The user's checkout of the base branch. Human edits and final commits belong here. Switching its branch changes the work context, not the folder's role. Use “primary directory” in technical prose if needed. |
| Workspace | A task's allocated execution context, including its branch and assigned directory, retained across commits. Deleting a task releases this allocation; its physical directory can serve a new workspace later. Qualify it as “task workspace” when distinguishing it from a VS Code workspace. |
| Workspace Folder | The physical task directory. It normally survives task deletion with its Git checkout structure and ignored local environment files. |
| Task Branch | The branch inside a task workspace, holding source commits independently of the base branch. |
| Preview | Saved primary content combined with connected workspaces' pending changes for testing. Connecting a workspace does not commit its changes to the base branch. |
| Preview Folder | The separate directory containing composed files, dependencies and runtime files. User-run tests and development servers run here. |
| Commits | Within a task, the recorded commits contributed to the base branch. Prefer **Commits to <branch>** for the history picker title. These are not all source commits in the workspace. |
| Pending Changes | Task changes not yet committed to the base branch. They may already have source commits in the task workspace, so do not call all of them “uncommitted.” |
| Baseline | Reference content for an operation. The preview baseline includes saved primary edits, which may be uncommitted. A task's incorporated baseline is an identified commit. |
| Source Boundary | The source revision and, for saved workspace deliveries, content tree separating a previous contribution from the next increment. It is distinct from the final squash commit. |
| Agent | The tool receiving task messages in its assigned workspace. It owns its tools and execution policies; Warden need not own its process or communicate through ACP. A legacy Executor label is only a label, not evidence of a connection or activity. |
| Task Chat | The persistent conversation bound to one repository, task and workspace. Opening it automatically resumes its agent session or creates the first session, without sending a prompt. |
| Session | An identified agent interaction bound to a task workspace, managed by Warden's integration or an external application. A new session does not create a task or workspace. |

A requirement remains the user's overall objective in the workflow documentation. It is not an
additional interface object or an approval/completion state. A successful commit also does not
complete the task, recycle its workspace or prove that an agent is idle.

## Action labels

| Interface wording | Meaning |
| --- | --- |
| Select Base Branch | Explicitly track the branch checked out in the primary folder; later checkouts restore tracked contexts only. This is independent of Git upstream tracking. |
| New Task | Save a task and allocate its workspace and task branch automatically. |
| Rename Task / Reorder Tasks | Change a task's title or order without changing Git. Tasks have no description or notes field. |
| Copy Task Brief | Copy the task title, workspace, base branch and working instructions for an external agent. |
| Delete Task… / Retry Delete | Confirm discarding task work and releasing its workspace while retaining the directory / explicitly finish an interrupted deletion. No recovery backup is created. Commits already on the base branch remain. |
| Open Workspace | Open the assigned directory. Legacy plans are prepared automatically on use. |
| Retry Workspace Allocation | Retry for the same task after a failed allocation. |
| Connect / Disconnect Preview | Include or remove a workspace's contribution in the preview. |
| Sync Preview | Synchronize the preview folder with saved primary content and connected task changes by recomposing them. Automatic synchronization uses the same operation. |
| Run Preview | Run the configured command in the preview folder; separate from synchronizing files. |
| Open Preview Terminal | Open or reveal a native terminal for the current repository's preview folder. |
| Rerun Preview Setup | Explicitly rerun the configured preview setup script; available on its Settings row and in the failure menu. |
| Show Preview Output | Show the current composition, path, synchronization details and setup output in the Warden output channel. |
| Rebase | Open Git rebase controls for task branches. Warden supplies the selected workspace paths and base branch. |
| Check Again | Repeat read-only rebase checks; do not execute a rebase. |
| Rebase Selected | Run Git rebase in the selected workspaces, targeting the base branch. |
| Commit to Base Branch | Commit the reviewed increment. When the destination is known, show **Commit to <branch>**, such as **Commit to feature/order**. |
| Chat with Agent / Reconnect | Open the task chat and prepare its session automatically / retry the task's agent connection. Outside a task chat, qualify the connection as an agent connection. |
| Agent Processes / End Agent Process | The Settings list of agent processes Warden started in this window / close one listed connection and its process. |
| Configure ACP | Reveal the native Settings view stacked below Workbench. Shown when an unavailable agent needs user action; hidden during workspace loading and pending connections. |
| Choose Agent Preset | Open the preset picker from Settings. A preset has one stable profile ID; selecting an existing one edits its settings instead of adding a duplicate. |
| Connect ACP / Reconnect ACP / Cancel Connection | Explicitly connect or retry from Settings / replace the connection / stop a pending connection attempt. Startup and profile changes connect automatically. Initialization creates no Warden task or work prompt. |
| Disconnect ACP | Close the workbench ACP connection and its owned process. Task conversations retain their own connections, ended from Agent Processes. |
| Workspace Setup Script | The user script run on task workspace allocation; distinct from Git commit hooks. |
| Preview Setup Script | The user script preparing the preview environment; distinct from the command running a development server. |

In rebase controls, Workspace identifies the execution context, not a separate kind of rebase.
The [operation guide](worktrees.md#synchronization) describes how Warden chooses the source boundary
and target and checks each workspace before invoking Git.

Use **Refresh** for rereading visible state, **Sync Preview** for composing preview files, and
**Rebase** for changing task branches. Preview synchronization flows from the primary
folder and connected workspaces into the preview folder; it does not copy preview edits back.
Use **Commit message** and **Commits** in their respective contexts. Use **Stop Turn**
for cancellation and **End Agent Process** when closing an active agent process; neither claims
that all commands started by the agent have stopped.

## Observable status vocabulary

The same protocol value can have different meanings by context. Keep the shared mappings in
`packages/shared/src/labels.ts` scoped to preview synchronization, rebase checks and execution results.

| Context | Labels |
| --- | --- |
| Preview sync | Out of Date / Syncing / Synced / Preview Conflict / Sync Failed |
| Preview fallback without task connections | Primary Only; freshness can still be shown separately |
| Legacy preview awaiting migration | Migration Required |
| Rebase check | Up to Date / Can Rebase / Conflicts Expected / Blocked / Unknown |
| Missing check | Not Checked |
| Rebase execution result | Rebased / Skipped / Failed, with per-workspace details |
| Script execution | Pending / Running / Succeeded / Failed |
| Agent activity without a final report | Outcome Unknown; preserve the last reported status and output without claiming that its command stopped |
| Agent-reported command result | `Exit <code>` / `Signal <name>`; shown beside the agent's tool status without reclassifying it |
| Task allocation | Workspace Allocation Failed with retry; legacy plans show Prepared on first use; archived plans show Archived |
| Interrupted commit with prepared content | Pending Commit; this does not certify review or testing |

**Conflicts Expected** is a forecast. **Preview Conflict** concerns composing the preview.
Actual rebase conflicts are reported through the execution result and Git state. Keep failures,
unknown states and stale checks distinct from success.

## Copy and compatibility

Use title case for named controls and short status labels; use sentence case for explanations
and errors. Use English punctuation and `lang="en"` for webviews. Preserve the actual operation,
reason and recovery action in error messages. Do not add a separate “delivery” or “acceptance” step.

“Delivery” remains an internal domain term for a recorded reviewed increment on the base branch.
The interface presents its concrete action and result as a commit. Git merge operations and Git hooks
keep their own meanings; they are not alternative names for Commit to….

Existing persisted fields, command IDs, error codes and hook environment variables stay compatible:

| Existing identifier | Concept |
| --- | --- |
| `developmentBranch`, `developmentHead`, `DevelopmentWorkflow`, `WARDEN_DEVELOPMENT_BRANCH` | Base branch, observed commit and work context |
| `workflow.changes`, `ChangePlan`, `DevelopmentChange`, `changeId` | Tasks and task identity |
| `worktree`, `slot`, `Surface: 'workspaces'` | Workspace path, internal physical allocation and workbench surface |
| `sourceBase`, `ChangeDelivery`, `deliveries`, `integration` | Source boundary, recorded base-branch commits and in-progress commit preparation |
| `warden.deliver`, `task.deliver`, `warden.taskHistory` | Commit to base branch and task commit history |
| Preview `syncStatus`, `synced`, `sources` | Preview sync status and composed contributions |
| `preview.refresh`, `warden.refreshPreview` | Sync Preview; existing action and command IDs remain compatible |
| `warden.showPreview`, `workspaces.show` with `surface: 'preview'` | Show Preview Output; retained entry points open native output instead of an editor page |
| `rebase.*`, `RebaseCheck`, `RebaseBatchResponse` | Git rebase checks and execution in task workspaces |

Use these concepts for new internal names where compatibility does not constrain them. Update this
contract, affected labels, command titles, stories and UI assertions together when terminology changes.
