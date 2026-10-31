# Fresh UI design brief

This brief contains the agreed product inputs for a new Warden page design. It deliberately omits
existing components, screenshots, navigation, data models and API constraints. Read it independently
of the current implementation. The scope is interaction design using shadcn/ui, not implementation.

## Product principles

- Warden is a passive local tool for one developer coordinating several agents on one requirement.
  Users operate Git and create workspaces through it; they do not maintain a second workflow for it.
- Show observable facts and operation results. No ready/idle/task-complete declarations, automatic
  completion detection, delivery reports or final requirement approval screen.
- The user decomposes work, chooses concurrency, tests results and accepts the requirement by
  inspecting commit history. No dependency enforcement, automatic dispatch or agent-driven planning.
- Use shadcn/ui components and visual style. Navigation must be coherent and concentrated in one
  area. Opening a worktree file is already review; no extra “enter review” step.
- Do not preserve the old page's structure as a constraint. Review and workspace operations are
  capabilities; their names do not dictate a fixed number of navigation modes or columns.

## Work and workspaces

The requirement has an explicitly chosen **base branch**, such as
`feature/order`, distinct from the company's default branch. Its checkout is the **primary
directory**, where the user edits human code. Dependencies and user-operated dev servers,
lint and tests use the independent preview directory.

Agent edits happen in task workspaces; human edits happen in primary. A worktree corresponds to one linear task. It can have
multiple local commits and deliver multiple commits to the base branch. Workspaces
remain available across deliveries. No automatic recycling, release step or task-end declaration.
Task branching/splitting into execution paths is outside the current scope.

TODO and orchestration are one ordered plan of changes contributing to the requirement. Ordering
expresses user intent, not dependencies. Adding a task automatically allocates its workspace and
branch. Storage and allocation details are internal; the user does not create a workspace separately.
Starting an agent and sending prompts remain explicit user actions.

Agent execution and interaction belong to external user tools. Warden creates workspaces and
provides creation/reuse hooks as a thin script interface: cwd, limited context, output and exit
status. It has no terminal-session or agent-process model. No default per-worktree dependency
installation, required agent tests, embedded editing or Neovim launch/jump integration.

## Connections

The user connects one or more worktrees to compose their live changes temporarily into an independent preview
directory, with saved primary content as baseline. Existing tools can preview the combined result there. Connection does not mean commit,
squash or acceptance. Selecting a workspace or file for review must not alter the connected set.

Disconnect removes that contribution. If establishing a connection conflicts, notify the user and
fail that attempt, leaving the workspace unconnected and the previous valid preview intact.
Conflicts cannot silently overwrite another contribution.
The UI must distinguish desired connections from what was actually synchronized and expose stale
preview content. Source worktrees remain intact. Unexpected preview-directory edits must be
preserved; primary edits are baseline inputs. Connection writes are one-way; agent fixes belong in task workspaces and human fixes in primary.

Formal integration isolates the reviewed delivery from other connected workspaces. Preview keeps running while delivery prepares and commits only the reviewed increment in primary. Do not invent a file-copy implementation or make preview a second editing environment.

## Review and delivery

Review the worktree before squash. Users request further work through their own tools, then choose
integration. Review presents the complete delivery diff and copyable file locations. Users review the entire
intended delivery; there are no read markers or review-completion declarations. Inline comments are removed.
The Web page supports commit-message entry and committing with normal Git
hooks; terminal use is not required. The user runs tests in the preview directory; no mandatory
test or agent handoff gate is established by this brief.

One task may deliver A1 and later A2, with another workspace's B1 between them. Make previously
delivered versus undelivered changes clear. The next delivery must not silently repeat A1. The
proposal is all current reviewed, undelivered changes without a picker. Exact granularity and
whether local source commits are required remain open; Web commit capability is settled.

## Rebase

Base branch updates trigger indicators and non-mutating checks, **not rebase**.
Show whether a workspace needs synchronization and whether it appears possible to rebase. A clean
checkout does not prove replayability or agent idleness. Unknown and stale results must be visible.

Users can request rebase for one, a selected set or all workspaces. Execution rechecks current Git
conditions; show per-workspace results and preserve work on failure. No automatic interrupt, agent
stopped checkbox or silent forced cleanup. Batch selection, preview connection and the workspace
being reviewed are different concepts and must be visually distinguishable.

## Commit history

Use VS Code's native Source Control Graph for commit browsing. History arrangement is deferred;
the current priority is reliable workspace connections and testing in the independent preview.

## Deliverable and review criteria

Produce one coherent information architecture, desktop wireframes, the main action flows,
observable state/error behavior, shadcn component mapping and narrow-screen behavior. Separate
agreed requirements from proposed labels and interactions. Keep unresolved decisions visible.

Review the design against these questions:

1. Can the user locate every global destination from one navigation area?
2. Does opening a file show its diff without a redundant mode switch?
3. Are review selection, connection membership and rebase batch selection unambiguous?
4. Can users perform ordinary operations without supplying lifecycle declarations?
5. Do Git writes happen only through the intended action, with visible scope and result?
6. Can A1/A2 remain linked to one workspace without a completion/recycling flow?
7. Are unknown, stale and failed checks shown honestly, without claiming tests passed or agents stopped?
8. Does the design remain a small workflow tool rather than a project-management platform?
