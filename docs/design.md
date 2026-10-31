# Warden page design

The VS Code extension implements the [workflow](workflow.md). See [VS Code](vscode.md) for the workspace sidebar, native review editors and packaged webview forms. Human editing uses
primary; runtime composition uses the independent preview directory. The new page is implemented.
Wireframes describe intent rather than exact labels. Updated 2026-10-30.

## Design method

An independent agent designed this proposal in a fresh conversation context, using only the agreed
requirements represented by the [design brief](ui-design-brief.md). It did not read the repository,
existing UI, screenshots or documentation. A second review of its own proposal clarified uncertain
delivery ranges, hook feedback and batch-operation behavior.

Warden is a passive tool. Users operate through it rather than reporting readiness, idleness or
task completion. It shows Git facts, connections and operation results. One workspace corresponds
to one linear task, can deliver several commits and remains available. Rebase is user-triggered.
The component and visual language is shadcn/ui.

## Compact VS Code layout

The current Git repository supplies context; Warden has no separate project card or project dialog.
The sidebar view and activity-bar entry are hidden while the window has no workspace folders,
including an empty saved workspace. Opening a folder makes Warden available. Single-folder windows
initialize automatically; multi-root selection and explicit base-branch configuration remain
native VS Code controls.
Repository discovery and switching have an explicit loading state, including before extension
activation finishes. Show loading feedback without repository or branch setup actions until the
repository state is known. The repository picker remains available when selection is needed and
for switching among multiple workspace roots.

Prefer native VS Code UI for navigation and ordinary operations. Select a webview only for a
specific interaction that benefits from a custom form or conversation layout. The workspace sidebar
uses `TreeView`; native commands, menus, inputs and pickers own everyday task operations.

Task rows expand into changed files and preserve their expansion across refreshes. Selecting a task
opens or restores its native diff without replacing a pinned version or resetting editor scroll.
Common actions (Agent, preview connection and commit) are inline tree actions. The context menu
contains editing, opening the assigned workspace, delivery records, synchronization, copying and recovery.
Drag tasks or use Alt+Up/Down to reorder the plan; the Command Palette offers a move picker.
The view heading places synchronization beside task creation and refresh. Its native **More Actions**
menu contains **Settings** for workspace initialization, preview setup and Agent configuration.

New-task entry and commit-message entry use native input boxes. Escape preserves the input draft
without changing Git. Commit keeps its original task, repository and review version; changes while
typing require renewed review. Workspace allocation is automatic; delivery records use pickers
and native diffs, and initialization output uses the Warden output channel.

Multiline task notes open an explicit editor webview with persistent task-bound drafts. Draft edits are saved to VS Code workspace state under the repository and task identity, so closing the editor preserves unsaved notes. Saving or discarding clears only the matching draft; later typing remains intact. Selecting
another task leaves that editor bound to its original task; switching repository or branch disables
saving until it is reopened in the matching context. Preview details, batch
rebase and script configuration retain dedicated editor panels. The primary sidebar navigation
contains no webview. **Task Chat** is a separate webview in the Secondary Side Bar by default.
Selecting a task still opens its diff; **Chat with Agent** explicitly switches the displayed chat.
The view title offers **Switch Task Chat** and **Open Chat in Editor**. An expanded chat offers
**Move Chat to Side Bar**; each task has one editable chat surface and the same underlying session.
Different tasks may be expanded side by side. Hiding or switching the view does not disconnect agents.

The task title, profile and connection state stay visible above a scrolling transcript; the composer
stays at the bottom. Session details scroll separately when narrow or short. Switching captures the
current draft and reading position before replacing the view binding. Background permission requests
and failures appear on task rows without changing focus. Users can move the view with VS Code's native
layout controls; Warden does not reset their chosen layout.

## Interface copy

These rules apply across navigation, task review, preview, synchronization, settings and
shared review controls. The wireframes below describe workflows, not required literal strings.
The [terminology contract](terminology.md) owns the vocabulary and status labels. In particular,
tasks describe planned work, workspaces hold its execution, preview synchronization composes files, and
Git rebase replays task commits onto the base branch.

- Give each fact one primary location. Delivery counts belong to the delivery disclosure; file
  count belongs to the file-list heading. Remove duplicate summaries, subtitle explanations
  of the page title and notes that merely restate the adjacent action.
- Use nouns for headings and verbs for actions. Within an identified object, shorten labels to
  the needed distinction: **Notes**, **Connect**, **Open Workspace**. Keep destinations on actions
  where they matter, such as **Commit to Base Branch**.
- Prefer familiar icons for navigation, refresh, edit, copy, terminal, settings, cancel, add,
  delete and reorder. Use the shared `IconButton` with an accessible name and a hover/focus
  tooltip; retain shortcuts in tooltips. Keep short text for primary actions and operations
  whose scope needs explanation, such as integration, Rebase, ending an Agent process,
  permission decisions. Menus retain their readable action names.
- Omit page headings that repeat the native tab title. Show branches, paths, timestamps and
  task associations directly, using icons, monospace and muted text for hierarchy. Preview
  composition uses task chips; observable sync and connection states use text badges with
  VS Code theme colors and high-contrast borders. Color never carries state by itself.
- Compact task edits, executor inputs and the conversation composer
  use placeholders and accessible names instead of repeated standalone labels. Preserve visible
  labels for script fields and agent-provided configuration whose values need disambiguation.
  Rebase selection uses one select-all checkbox with partial-selection feedback and a count.
- Keep secondary content on demand: delivery records and script output. Preserve accessible names
  and tooltips on icon buttons. Errors and recovery actions must remain visible.
- Task rows show at most two facts, prioritizing permission requests, failures and stale reviews;
  the tooltip retains the complete context. Delivery records retain native commit-file review.
- Empty preview setup and synchronization controls stay hidden until their configuration or
  workspaces exist. A failed check still offers retry. A visible form owns its scoped error;
  native notifications draw attention to errors whose form is not visible.
- Task copy actions use the more-actions menu; workspace storage, directory and branch choices
  stay internal. Hiding a task editor preserves its unsaved notes.
- Empty states give one next step or a short fact, such as **Select a task** or **No changes**. Loading,
  unavailable data, stale checks and empty results are distinct; do not turn unknown data into
  a zero count or claim successful synchronization before it runs.
- State operation consequences once, beside the relevant action. Keep normal commit hooks, recovery after failure, rebase semantics
  and no automatic push explicit. Preserve failure reasons, conflicting paths and recovery steps.
  Product philosophy and internal allocation mechanics belong in documentation.
- Toasts report the outcome, not a second description of the workflow. **Copied** does not repeat
  the copied payload. Do not rewrite user titles, commit messages, hook scripts or Git/script output.

| Concept | Interface vocabulary |
|---|---|
| Ordered work and one item | Tasks / Task; New Task |
| Review content | Changes for changed content; Diff for its comparison |
| Delivery history and current scope | Commits / Pending Changes / Pending Commit |
| Workspace hooks | Workspace Setup Script; show script configuration, output and exit status |
| Preview synchronization | Sync Preview; Out of Date / Syncing / Synced / Preview Conflict / Sync Failed |
| Rebase checks | Up to Date / Can Rebase / Conflicts Expected / Blocked / Unknown / Not Checked |
| Unusable check results | Check Failed / Check Again, with a reason or recovery action |

Review copy in context, including empty, loading, failed and expanded states. Existing Storybook
interaction checks must continue to find controls by their accessible names after label changes.

## One navigation area, one ordered work plan

The selected base branch is the current context. The only global navigation area
is on the left, with preview and tasks:

- **Preview**: the current combination, last successful sync, sync action and conflict feedback.
- **Tasks**: an ordered task list with connection switches; each item directly opens its workspace, commands and diff.

**Settings** opens from the view heading's **More Actions** menu.

The list itself is the orchestration entry point, not another page to enter before reaching work.
Adding a task prepares its workspace automatically; commands, review and delivery use the task row.
There is no separate review mode, allocation dashboard or delivery center.

```text
┌────────────────────────────┬─────────────────────────────────────────────────────┐
│ Warden                     │ Task diff, preview or task notes                    │
│                            │                                                     │
│ feature/order      ...     │ No second workspace picker or global page tabs      │
│ /project                   │                                                     │
│                            │                                                     │
│ Preview                 2  │                                                     │
│                            │                                                     │
│ Tasks                   +  │                                                     │
│   1 Order API              │                                                     │
│     4 changed files        │                                                     │
│   2 Form Validation        │                                                     │
│     Rebase Available       │                                                     │
│   3 Integration            │                                                     │
│     Not in Preview         │                                                     │
│                            │                                                     │
│ Rebase                  2  │                                                     │
└────────────────────────────┴─────────────────────────────────────────────────────┘
```

`feature/order` is the chosen **Base Branch**, not an alias for the repository default branch. Its
menu holds repository, primary-directory and branch context settings, plus **Settings**. The content header
identifies the selected object and its actions; it does not duplicate global navigation.

Task rows display at most two relevant facts, without “Done”, “Awaiting Acceptance” or “Agent Idle” badges.
Dragging the list changes plan order only; label the action “Reorder Tasks”. “Rebase” opens a batch
operation sheet rather than a fourth permanent page. Settings hold workspace hooks and an ACP
configuration entry with a collapsed example.

Assumption: one repository and base branch in the current context. Cross-repository
and multi-requirement dashboards are outside this design.

Before the branch is selected, show only the next setup action: choose the repository if needed,
then choose the base branch. Hide task, preview and synchronization surfaces,
their toolbar actions and preview status until configuration exists. A workflow page opened directly
uses the same short setup prompt. Keep errors visible and put workflow education in documentation.

## Add a task

`＋` opens a native input for the task title. Enter creates the task and its workspace; Escape cancels and keeps
the draft and prior selection. Drafts are scoped to the repository and base branch, and clear
after the task is saved, including when allocation needs a retry. Multiline notes are
edited separately on request.

The native input owns its creation draft and consumes the created task ID directly. The task editor
webview only edits an existing task; it carries no creation lifecycle or workspace-options state.

```text
Order API                                           [Edit Notes]
Add filters to the order list…

Not in Preview
[Chat with Agent] [Connect Preview] [Open Workspace]
```

Task creation allocates a fresh shared Git workspace without a separate setup action or storage,
directory, branch or executor inputs. Existing independent clones remain supported. Numbered
task paths remain stable across deliveries. The task expands into its native changed-file list;
selecting a file opens the read-only diff editor.

Warden creates the workspace and runs its configured initialization hook. The user can then open
a separate task-bound ACP conversation or use external tools. ACP supplies text prompts, updates,
permission choices and explicit session controls; agents execute their own file and command tools.
The conversation stays attached to its original task and repository as navigation changes.
See the adopted [ACP boundary](acp-design.md); it adds no client filesystem/terminal tools, agent
sandbox or execution guard and does not change the native review flow.

Show a hook's output and exit code. Distinguish “Workspace created; setup script exited with code 1” from workspace
creation failing. Retrying a hook is explicit; do not roll back arbitrary user-script modifications.
Allocation failure retains the task and its error with **Retry Workspace Allocation** on that row. Retry uses the
same task. Older unallocated plans are prepared automatically on use; archived plans require restoration.

## Compose the independent preview

The left **Tasks** list is the one place to manage workspace connections. Each allocated task
has a switch for connecting to the independent preview, available while viewing preview or
task details. Failed allocations have no connection switch until retried. Selecting a task still opens its review;
changing its connection does not change the selected task or plan order.

“Preview” shows the current combination, runtime path, last successful sync, sync action
and errors or conflicting paths. It has no duplicate workspace table or preview-file list; file
review belongs to the selected workspace.

```text
Preview                                    /warden-data/preview
Base branch: feature/order

Preview contents: Order API + Form Validation
Last successful sync: 10:42:16
```

Connection membership, review selection and rebase batch selection are separate concepts with
separate controls. Connecting does not stage, squash or accept changes.

**Agreed:** if establishing a connection would introduce a conflict, notify the user and fail that
connection attempt. Do not show it as connected or partially apply its contribution. Preserve the
previous valid preview and identify the conflicting files. Warden does not resolve the conflict
or require a conflict-resolution workflow before the user can do anything else.

Other proposed behavior, including later updates to an already established connection:

- Turning a connection on attempts to add its live contribution. Turning it off attempts to remove
  that contribution while preserving the remaining combination.
- Show pending requests explicitly. Failed connection must not look connected; failed disconnection
  must not claim the contribution is gone.
- If an established connection cannot apply newer source changes, keep the relationship visible but
  mark its content stale. Show the last successfully presented snapshot and affected files.
- Two workspaces touching one file do not automatically conflict. Show the composition result,
  including unknown or failed checks.
- Preserve unexpected preview-directory edits and pause writes that could overwrite them. Name the
  affected files. Dependencies, ignored files and the user's running processes are not contributions.

```text
Preview Out of Date
The preview still contains the composition from 10:42:16.

New Form Validation changes conflict with Order API:
src/types/order.ts

[Sync Preview]
```

Human code is edited in primary and agent code in task workspaces. Users run dev servers, lint
and tests in preview. Saved primary content forms the baseline; content-based observation and
debouncing update each workspace’s synchronization status. Connection health cannot establish that
tests passed. Preview files are generated and cannot be edited through Warden.

## Selecting a file is review

Present current undelivered content in one file list, including live uncommitted edits. Do not split
review into staged and unstaged piles or offer line, hunk or file staging controls. Users must review
all content they intend to commit. Warden does not track per-file read status or review progress;
staging through external tools does not establish that content has been reviewed.

The workspace detail directly presents its file list and diff. Clicking a file displays it without
“Enter Review”, “Switch Review Area” or “Mark Review Complete”. Local file selection does not create a second global
navigation system, alter the connection set or implicitly narrow the delivery scope.

Review provides copyable file locations. Inline comments, the review rail and comment
feedback commands have been removed. Users exchange feedback through their own tools.

After A1, review defaults to the reliably identified undelivered changes:

```text
Recorded commit: A1
Review scope: pending changes since the last recorded contribution
```

This is product meaning, not a promise of Git ancestry. A1 may have been squashed or its SHA
rewritten. It must not reappear as new work because an identifier changed. If the boundary cannot
be determined, show “Pending change range is unknown” and the reason; do not present the entire cumulative branch
diff as A2. Recompute the range without asking for task-completion declarations.

“Delivery scope” means which changes from that workspace enter the next base-branch commit.
For A1 already delivered and A2 now under development, the next scope must exclude A1. The first implementation delivers all reliably identified, reviewed and not-yet-delivered
changes from a clean committed source, without a file or local-commit picker. Live connection
previews continue to include uncommitted edits. `sourceBase` records the last delivered source tip.

## Integrate a reviewed delivery

“Commit to Base Branch” opens a message field and identifies the complete small delivery. When the branch
is known, the input title names it directly, such as “Commit to feature/order”. The source
commit, delivery boundary and primary HEAD are fixed by the review. Background refresh cannot
silently move this version; changes require refreshing the comparison and reviewing the full range.
No read markers, checkpoints, test-passed checkboxes or agent-idle declarations are required.

Submitting the message composes and commits the reviewed increment in one action. Canceling before
submission leaves Git untouched. Other connections remain in the independent preview, where tests
and dev servers keep running. Unrelated primary edits or Git operations block delivery and are
preserved. Warden does not stage them into the task’s commit.

Preparation is journaled internally. A failed hook or interrupted operation leaves its contents
available, with the error and a recovery action. Recovery reviews the retained index fingerprint
or exact manual commit before accepting it. Successful commit advances the baseline and records
the delivery; the task workspace remains available for A2 and A3. Preview sync failure is reported
separately and cannot turn a successful commit into an apparent failed delivery.

## Check automatically; rebase on request

Base branch changes update indicators and non-mutating checks. They never trigger
rebase. “Rebase” opens a sheet supporting one, selected or all workspaces:

```text
Rebase
Target: feature/order · c42e91
Checked at 10:45:08                                  [Check Again]

[ ] Workspace          Check result
[x] Order API          Can Rebase
[x] Form Validation    Conflicts Expected · 2 files
[ ] Integration        Unknown · Unable to read Git status

[Select All]                                [Rebase Selected]
```

“Conflicts Expected” is a forecast, not an actual Git conflict. Unknown and stale are separate conditions.
Results refer to checked source/destination revisions; history rewording can invalidate them even
if file content stays identical. A clean worktree does not prove idleness.

Recheck before execution. Proposed batch behavior leaves known conflicts, unknown results,
uncommitted work and other obstructions unexecuted with explicit reasons. Process eligible rows
and show every result. “All” specifies scope, not permission to force through blockers; skipped
rows cannot be counted as synchronized. The user can handle those workspaces manually.

Conflicts arising during actual execution are different: show the real Git state and affected
files. Exact continue/abort interactions remain to be designed; Warden does not embed an editor or
promise that abort preserves every new conflict-resolution edit. Do not automatically stash,
clean, interrupt agents or request an agent-stopped checkbox.

Use facts such as “Up to Date”, “Skipped: uncommitted changes” and “Rebase stopped at a conflict”, without changing task status.

## Commit history

Commit browsing belongs to VS Code's native Source Control Graph. History arrangement is deferred
so development can focus on connecting workspace changes and testing them in the independent preview.
Task delivery records remain accessible from the task context menu.

## Observable facts and persistent errors

Avoid an omnibus task status. Each surface shows only facts it can establish:

| Object | Display | Do not infer |
|---|---|---|
| Plan item | Order, notes, associated workspace | Started, finished or dependencies satisfied |
| Git workspace | Branch, path, changed files, relation to base branch, Git operation | Agent activity or code correctness |
| Hook | Result, output, exit code | Environment fully prepared or dependencies installed |
| Preview | Applied combination, last successful snapshot, pending/failed update | A failed or unknown check means current content |
| Rebase check | Forecast, checked revisions, freshness | Clean means idle; forecast conflict is an actual conflict |
| Delivery | Recorded contribution, current range, commit result | Task completion or requirement approval |

Errors stay near their scope with what changed, what did not, the actual state and possible next
actions. Short toasts suit “Message sent” or “Task order saved”. Connection failures, Git conflicts, hook
failures and rejected operations remain inspectable after a toast disappears. Partial
success must not masquerade as either total success or total failure.

## shadcn/ui and responsive layout

Use neutral surfaces, thin borders and restrained emphasis. Preserve diff space instead of filling
the page with dashboard cards. Do not use green task-completion badges.

| Purpose | Components |
|---|---|
| Navigation, connections and file review | Native VS Code tree, commands and read-only diff editors |
| Actions | Native tree menus and commands; editor webviews use `Button` and `DropdownMenu` |
| Forms and selection | Native inputs/pickers first; complex editor forms use shadcn primitives |
| Details and output | Native `details` disclosures; errors and recovery stay visible |
| Feedback | Scoped inline messages; native notifications when the affected view is hidden |

Proposed desktop dimensions: navigation 248–280 px, file list 240–300 px, remaining width for diff,
36–40 px action rows and approximately 14 px body text. Paths, SHAs and diffs use monospace. Keep
one prominent current action per surface; secondary operations use ordinary buttons or menus.

VS Code owns navigation and diff editor sizing. Webview forms wrap to the available editor
width without a second navigation system. Rebase rows wrap without hiding selection, uncertainty or errors.

## First-version boundaries and explicit exclusions

The implementation follows these bounded choices:

1. Later connection conflicts preserve the last coherent preview and mark it stale. Unexpected
   preview-directory edits block replacement; saved primary edits are baseline inputs.
2. Each delivery includes all undelivered changes from a clean committed source. Delivery records
   preserve source boundaries independently of squash/rewrite SHAs. There is no subset picker.
3. The page creates the primary commit with ordinary Git hooks. No terminal-only commit requirement.
4. Rebase checks run in isolated temporary worktrees; explicit execution leaves actual
   conflicts for manual handling. Batch results are per workspace.
5. The Git mechanism remains an internal engine package. Warden's external shared Git repository
   backs task, preview and operation worktrees; primary remains separate. External backups and
   operation journals support interrupted operations, not undo UI.

Do not add task branching, dependency scheduling, completion declarations, vendor-specific agent SDKs,
ACP client file/terminal tools, default dependency installation, test gates, automatic rebase/stash/recycling,
automatic force-push or general project management.

## Design review

Connection switches in the navigation stay available from every page. “Preview” explains the
current combination and runtime path. The plan list opens work directly without planning/allocation/review/delivery
navigation layers.

The proposal keeps these operations independent:

- Review selection, connection membership and rebase batch selection.
- Connection and commit creation.
- Automatic checks and requested rebase.
- Commit-message input and Git writes.
- A successful delivery and an assertion that a task ended.

Remaining complexity explains real operations: stale preview content, source ranges and rebase conflicts. It must not become extra lifecycle bookkeeping. Implementation and
extension-host and webview browser verification follow these boundaries.

## Research references

These references were inspected for the earlier design on 2026-10-15. They document retained
engine mechanisms, including the deferred history implementation, rather than the current feature scope.

| Reference | Relevant evidence | Implication for Warden |
|---|---|---|
| [Pro Git: Rewriting History](https://github.com/progit/progit2/blob/main/book/07-git-tools/sections/rewriting-history.asc) | Interactive history editing covers rewording, reordering and the effect on later commits. | The user interface can remove command-line ceremony without inventing new Git semantics. |
| [Git cherry-pick documentation](https://github.com/git/git/blob/master/Documentation/git-cherry-pick.adoc) | Replay can conflict; merge commits and commits that become empty require explicit handling. | A temporary branch is a plausible basis, but “replay succeeded” and “the requested history is correct” are separate conclusions. |
| [git-branchless](https://github.com/arxanas/git-branchless), [move](https://github.com/arxanas/git-branchless/wiki/Command:-git-move), [restack](https://github.com/arxanas/git-branchless/wiki/Command:-git-restack) | Commit movement, undo and repairing descendants after rewriting are established workflows. | Study rewrite mapping and subsequent work; its undo feature is outside Warden's scope. This is a tool, not a ready-made TypeScript history-editing API. |
| [GitButler](https://github.com/gitbutlerapp/gitbutler) | Commit reword/move operations, parallel branches and an operation timeline are presented together. | Useful interaction reference. It is a larger Rust application; reuse is a separate technical and license decision. |
| [simple-git](https://github.com/steveukx/git-js/tree/main/simple-git) | Provides a JavaScript interface to the installed Git executable, including raw commands and rebase. | A command wrapper does not supply Warden's delivery mapping, preview isolation or operation-result handling. |
| [libgit2 cherry-pick APIs](https://libgit2.org/docs/reference/main/cherrypick/index.html) | Exposes native cherry-pick operations. | An alternative building block, not a solution for the complete interaction; native integration needs evaluation later. |
| [Git rebase: update-refs](https://github.com/git/git/blob/master/Documentation/git-rebase.adoc) | Branches checked out in another worktree are excluded from automatic reference updates. | Sibling workspace synchronization cannot be assumed to happen just by enabling this option. |
| [Git update-ref](https://github.com/git/git/blob/master/Documentation/git-update-ref.adoc) | Reference updates can require an expected old value and participate in transactions. | There is support for detecting a moved branch, but reference updates alone do not coordinate checkout files and Warden state. |
