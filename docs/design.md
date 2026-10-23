# Warden page design

The browser and native VS Code extension share the [workflow](workflow.md). Human editing uses
primary; runtime composition uses the independent preview directory. The new page is implemented.
Wireframes describe intent rather than exact labels. Updated 2026-10-23.

## Design method

An independent agent designed this proposal in a fresh conversation context, using only the agreed
requirements represented by the [design brief](ui-design-brief.md). It did not read the repository,
existing UI, screenshots or documentation. A second review of its own proposal clarified uncertain
history boundaries, delivery ranges, hook feedback and batch-operation behavior.

Warden is a passive tool. Users operate through it rather than reporting readiness, idleness or
task completion. It shows Git facts, connections and operation results. One workspace corresponds
to one linear task, can deliver several commits and remains available. Rebase is user-triggered.
The component and visual language is shadcn/ui.

## Interface copy

These rules apply across navigation, task review, preview, history, synchronization, settings and
shared review controls. The wireframes below describe workflows, not required literal strings.

- Give each fact one primary location. Delivery counts belong to the delivery disclosure; file
  count belongs to the file-list heading. Remove duplicate summaries, subtitle explanations
  of the page title and notes that merely restate the adjacent action.
- Use nouns for headings and verbs for actions. Within an identified object, shorten labels to
  the needed distinction: **说明**, **起点**, **调整历史**. Keep destinations on actions
  where they matter, such as **提交到主开发分支** and **应用到 feature/order**.
- Prefer familiar icons for refresh, edit, save, cancel, add, delete and reorder. Use
  compact square buttons with an accessible name and a tooltip; retain shortcuts in tooltips.
  Keep short text for navigation and consequential actions such as integration, synchronization
  and history rewriting, where an icon alone would leave the scope unclear.
- Keep secondary content on demand: delivery records and script output. Preserve accessible names
  and tooltips on icon buttons. Errors and recovery actions must remain visible.
- Empty states give one next step or a short fact, such as **请选择任务** or **暂无变更**. Loading,
  unavailable data, stale checks and empty results are distinct; do not turn unknown data into
  a zero count or claim successful synchronization before it runs.
- State operation consequences once, beside the relevant action. Keep normal commit hooks, recovery after failure, rebase semantics, history rewriting
  and no automatic push explicit. Preserve failure reasons, conflicting paths and recovery steps.
  Product philosophy and internal allocation mechanics belong in documentation.
- Toasts report the outcome, not a second description of the workflow. **已复制** does not repeat
  the copied payload. Do not rewrite user titles, commit messages, hook scripts or Git/script output.

| Concept | Interface vocabulary |
|---|---|
| Ordered work and one item | 工作区 / 任务; 新增任务 / 添加任务 |
| Review content | 变更 for changed content; 差异 for its code comparison |
| Delivery history and current scope | 交付 / 未交付 / 待提交 |
| Workspace hooks | 工作区脚本; show script configuration, output and exit status |
| Synchronization checks | 已同步 / 预计可同步 / 预计冲突 / 暂不可同步 / 无法判断 / 未检查 |
| Unusable check results | 检查失败 / 需重新检查, with a reason or recovery action |

Review copy in context, including empty, loading, failed and expanded states. Existing Storybook
interaction checks must continue to find controls by their accessible names after label changes.

## One navigation area, one ordered work plan

The selected primary development branch is the current context. The only global navigation area
is on the left, with three kinds of content:

- **预览**: the current combination, last successful update, refresh action and conflict feedback.
- **提交历史**: accepted commits, message edits and history-arrangement drafts.
- **工作区**: an ordered task list with connection switches; each item directly opens its workspace, commands and diff.

The list itself is the orchestration entry point, not another page to enter before reaching work.
Workspace creation, command invocation, review and delivery actions stay within the same task detail.
There is no separate review mode, allocation dashboard or delivery center.

```text
┌──────────────────────┬─────────────────────────────────────────────────────┐
│ Warden               │ Selected task, primary preview or commit history    │
│                      │                                                     │
│ feature/order     ⋯  │ No second workspace picker or global page tabs     │
│ /project             │                                                     │
│                      │                                                     │
│ 预览         2 │                                                     │
│ 提交历史             │                                                     │
│                      │                                                     │
│ 工作区            ＋ │                                                     │
│ ⋮⋮ 1 订单接口        │                                                     │
│      4 个变更文件    │                                                     │
│ ⋮⋮ 2 表单校验        │                                                     │
│      需要同步        │                                                     │
│ ⋮⋮ 3 联调调整        │                                                     │
│      尚无工作区      │                                                     │
│                      │                                                     │
│ 同步工作区         2 │                                                     │
│ 设置                 │                                                     │
└──────────────────────┴─────────────────────────────────────────────────────┘
```

`feature/order` is the chosen **主开发分支**, not an alias for the repository default branch. Its
menu holds repository, primary-directory and branch context settings. The content header identifies
the selected object and its actions; it does not duplicate global navigation.

Task rows display at most two relevant facts, without “完成”, “待验收” or “agent 空闲” badges.
Dragging the list changes plan order only; label the action “调整计划顺序”. “同步工作区” opens a batch
operation sheet rather than a fourth permanent page. Settings hold workspace hooks,
not general project-management configuration.

Assumption: one repository and primary development branch in the current context. Cross-repository
and multi-requirement dashboards are outside this design.

## Plan and create a workspace

`＋` creates a plan item with a title and optional description. It does not allocate a workspace,
ask for an owner or lifecycle state, or impose a dependency or delivery-report form.

```text
订单接口                                             [编辑说明]
为订单列表增加筛选参数……

尚无工作区
创建后可查看 Git 差异，并执行已配置的工作区脚本。

[创建工作区…]
```

The creation sheet identifies the branch and worktree path. An explicit option may associate an
existing workspace, showing its real branch and path. Directory-name similarity does not establish
task identity. New tasks default to shared Git workspaces outside primary; independent clones are
available for compatibility. Existing primary-linked worktrees can still be associated. Numbered
task paths remain stable across deliveries, and internal repository layout does not add UI steps.

After creation, the same task detail becomes the working surface:

```text
订单接口                 feature/order-api · /worktrees/order-api
已记录交付：A1           本次变更：4 个文件
────────────────────────────────────────────────────────────────
任务说明                                                   [展开]

工作区脚本：已完成                                      [展开结果]
────────────────────────────────────────────────────────────────
本次变更                  │ src/api/orders.ts
src/api/orders.ts      M  │
src/types/order.ts     M  │   - 原内容
src/api/filter.ts      A  │   + 新内容
                          │                            [复制位置]
────────────────────────────────────────────────────────────────
相对于已记录交付的未交付变化                             [提交到主开发分支…]
```

Warden creates the workspace and runs any configured creation/reuse hook. Agent launch, prompt
submission and process control belong to the user's external tools or scripts. The page has no
terminal controls or agent-session state.

Show a hook's output and exit code. Distinguish “工作区已创建；hook 退出码 1” from workspace
creation failing. Retrying a hook is explicit; do not roll back arbitrary user-script modifications.

## Compose the independent preview

The left **工作区** list is the one place to manage workspace connections. Each allocated task
has a switch for connecting to the independent preview, available while viewing preview, history or
task details. Unallocated plans have no connection switch. Selecting a task still opens its review;
changing its connection does not change the selected task or plan order.

“预览” shows the current combination, runtime path, last successful update, refresh action
and errors or conflicting paths. It has no duplicate workspace table or preview-file list; file
review belongs to the selected workspace.

```text
预览                                    /warden-data/preview
主开发分支：feature/order

预览目录当前呈现：订单接口 + 表单校验
最近成功更新：10:42:16
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
预览未更新
预览目录仍呈现 10:42:16 的组合。

表单校验的新变化与订单接口冲突：
src/types/order.ts

[重新检查]
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
“进入审查”, “切换审查区” or “标记审查完成”. Local file selection does not create a second global
navigation system, alter the connection set or implicitly narrow the delivery scope.

Review provides copyable file locations. Inline comments, the review rail and comment
feedback commands have been removed. Users exchange feedback through their own tools.

After A1, review defaults to the reliably identified undelivered changes:

```text
已记录交付：A1
当前审查范围：相对于已记录交付的未交付变化
```

This is product meaning, not a promise of Git ancestry. A1 may have been squashed or its SHA
rewritten. It must not reappear as new work because an identifier changed. If the boundary cannot
be determined, show “交付范围尚未确认” and the reason; do not present the entire cumulative branch
diff as A2. Recompute the range without asking for task-completion declarations.

“Delivery scope” means which changes from that workspace enter the next primary development commit.
For A1 already delivered and A2 now under development, the next scope must exclude A1. The first implementation delivers all reliably identified, reviewed and not-yet-delivered
changes from a clean committed source, without a file or local-commit picker. Live connection
previews continue to include uncommitted edits. `sourceBase` records the last delivered source tip.

## Integrate a reviewed delivery

“提交到主开发分支…” opens a message field and identifies the complete small delivery. The source
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
the delivery; the task workspace remains available for A2 and A3. Preview update failure is reported
separately and cannot turn a successful commit into an apparent failed delivery.

## Check automatically; rebase on request

Primary development branch changes update indicators and non-mutating checks. They never trigger
rebase. “同步工作区” opens a sheet supporting one, selected or all workspaces:

```text
同步工作区
基于 feature/order · c42e91
检查时间 10:45:08                                  [重新检查]

[ ] 工作区         同步情况           检查结论
[✓] 订单接口       需要同步           预计可直接 rebase
[✓] 表单校验       需要同步           预计有冲突 · 2 个文件
[ ] 联调调整       尚不能判断         无法读取 Git 状态

[选择全部工作区]                          [Rebase 所选 2 个工作区]
```

“预计有冲突” is a forecast, not an actual Git conflict. Unknown and stale are separate conditions.
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

Use facts such as “已更新”, “未执行：有未提交改动” and “rebase 停在冲突”, without changing task status.

## Arrange accepted history and edit messages

The history page first shows actual commits on the primary development branch. Users inspect them
to assess the requirement without a separate final approval flow.

```text
提交历史                                          feature/order
提交顺序：早 → 晚

A1  增加订单接口        来源：订单接口 · 第 1 批       71a…
B1  增加表单校验        来源：表单校验 · 第 1 批       894…
A2  增加筛选参数        来源：订单接口 · 第 2 批       c42…

                                                  [编排历史…]
```

**Range interaction:** select a start commit and include history through current HEAD.
Display the exact range before creating a draft. Do not infer the requirement baseline from the
default branch or include all repository history automatically. The first version rejects root
and merge commits and never pushes rewritten history automatically.

```text
历史草稿
基于 feature/order · c42e91
范围：A1 至当前末端                              实际分支尚未改变

原顺序                    草稿顺序
1 A1                      ⋮⋮ 1 A1 增加订单接口
2 B1                      ⋮⋮ 2 A2 增加筛选参数          [修改说明]
3 A2                      ⋮⋮ 3 B1 增加表单校验

3 个提交；不合并提交
[丢弃草稿]                                      [预览改写结果]
```

Sorting the work plan changes only the plan. Sorting here changes the history draft. Message
edits also stay in the draft; neither immediately amends the real branch. Navigating away preserves
the draft without locking the user into this page.

Preview candidates in isolation. Show before/after order, message changes and any difference
between the candidate's final file content and the original history. Identify conflicting commits
and files. Conflict-free replay does not prove intermediate commits are independently useful or
tested. Draft edits invalidate earlier previews; conflicting candidates remain unapplied.

This draft adds no embedded conflict editor. Users can revise the arrangement and preview again;
the external conflict-resolution interaction is still open.

For a valid preview, “应用到 feature/order” requires the same branch revision,
a clean primary checkout and application of exactly the reviewed candidate. If B2
arrived while the draft was open, retain the draft and expose its stale basis:

```text
主开发分支已有新提交 B2。
此草稿基于 c42e91，尚未包含最新历史。

[基于最新历史重建草稿]
```

Rebuilding may preserve ordering intent for review, but requires another preview. Never overwrite
B2 or silently force-push. After application show the resulting history and operation outcome.

**Agreed:** there is no undo or restore-history feature. If users want a different result after
application, they arrange the current history or edit its messages again. Do not add a recovery-point
picker, rollback action or undo timeline. Discarding an unapplied draft remains possible because it
has not changed Git history. A failed preview leaves the original history intact.

Updating the independent preview after a commit remains part of preview behavior; it does not undo
the commit or require a new user-maintained task state. Handling interrupted Git operations must
report the actual state and preserve work, without becoming a history-undo product feature.

Use stable task/workspace/delivery associations, not only SHAs or directory names. Rewording and
reordering may change identifiers without changing which task delivered the content.

The user's backup-branch plus temporary-branch/cherry-pick idea remains a candidate mechanism,
not a requirement for a user-facing undo feature.
A backup branch preserves committed history, not arbitrary local files, connected previews or
Warden metadata. No library, Git operation API or separate repository is selected here.

## Observable facts and persistent errors

Avoid an omnibus task status. Each surface shows only facts it can establish:

| Object | Display | Do not infer |
|---|---|---|
| Plan item | Order, notes, associated workspace | Started, finished or dependencies satisfied |
| Git workspace | Branch, path, changed files, relation to primary branch, Git operation | Agent activity or code correctness |
| Hook | Result, output, exit code | Environment fully prepared or dependencies installed |
| Preview | Applied combination, last successful snapshot, pending/failed update | A failed or unknown check means current content |
| Rebase check | Forecast, checked revisions, freshness | Clean means idle; forecast conflict is an actual conflict |
| Delivery | Recorded contribution, current range, commit result | Task completion or requirement approval |
| History draft | Candidate, preview, application result | The real branch has already changed |

Errors stay near their scope with what changed, what did not, the actual state and possible next
actions. Short toasts suit “文本已发送” or “计划顺序已保存”. Connection failures, Git conflicts, hook
failures and rejected history applications remain inspectable after a toast disappears. Partial
success must not masquerade as either total success or total failure.

## shadcn/ui and responsive layout

Use neutral surfaces, thin borders and restrained emphasis. Preserve diff space instead of filling
the page with dashboard cards. Do not use green task-completion badges.

| Purpose | Components |
|---|---|
| Single navigation area | `Sidebar`, `SidebarMenu`, `ScrollArea` |
| Files and diff | `ResizablePanelGroup`, `ScrollArea`, `Separator` |
| Actions | `Button`, `DropdownMenu` |
| Creation, delivery and rebase panels | `Sheet` |
| Rebase selection and commits | `Table`, `Checkbox` |
| Connections | `Switch` with workspace labels and pending/error feedback |
| Observable facts | Restrained `Badge`, `Alert`, `Tooltip` |
| Notes, inputs and operation output | `Collapsible`, `Textarea` |
| Short feedback | `Sonner` |
| Sorting | shadcn-style rows with drag and accessible move-up/down actions |

Proposed desktop dimensions: navigation 248–280 px, file list 240–300 px, remaining width for diff,
36–40 px action rows and approximately 14 px body text. Paths, SHAs and diffs use monospace. Keep
one prominent current action per surface; secondary operations use ordinary buttons or menus.

On narrow screens, the same navigation becomes a drawer opened by “工作导航”; do not add a second
bottom navigation system. Files and diff use local layers and unified diff. Sheets become nearly
full-screen. History before/after lists stack vertically and retain move-up/down controls. Rebase
rows wrap without hiding selection, uncertainty or errors.

## First-version boundaries and explicit exclusions

The implementation follows these bounded choices:

1. Later connection conflicts preserve the last coherent preview and mark it stale. Unexpected
   preview-directory edits block replacement; saved primary edits are baseline inputs.
2. Each delivery includes all undelivered changes from a clean committed source. Delivery records
   preserve source boundaries independently of squash/rewrite SHAs. There is no subset picker.
3. The page creates the primary commit with ordinary Git hooks. No terminal-only commit requirement.
4. History edits cover a selected start through HEAD within the latest 100 commits, excluding root
   and merge commits. Isolated cherry-pick preview must preserve final content. Apply is local only.
5. Rebase checks run in isolated temporary worktrees; explicit execution leaves actual
   conflicts for manual handling. Batch results are per workspace.
6. The Git mechanism remains an internal server module. Warden's external shared Git repository
   backs task, preview and operation worktrees; primary remains separate. External backups and
   operation journals support interrupted operations, not undo UI.

Do not add task branching, dependency scheduling, completion declarations, agent-specific SDKs,
ACP integration, default dependency installation, test gates, automatic rebase/stash/recycling,
history undo/restore, automatic force-push or general project management.

## Design review

Connection switches in the navigation stay available from every page. “预览” explains the
current combination and runtime path. The plan list opens work directly without planning/allocation/review/delivery
navigation layers.

The proposal keeps these operations independent:

- Plan order and accepted-history order.
- Review selection, connection membership and rebase batch selection.
- Connection and commit creation.
- Automatic checks and requested rebase.
- Draft message edits and changes to the actual branch.
- A successful delivery and an assertion that a task ended.

Remaining complexity explains real operations: stale preview content, source ranges, replay conflicts
and previewed history edits. It must not become extra lifecycle bookkeeping. Implementation and
browser verification follow these boundaries.

## Research references

Initial references inspected on 2026-10-15. These inform the design; no dependency has been selected
and no third-party implementation is being incorporated.

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
