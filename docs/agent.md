# Comments and the agent

Writing comments, handing them to the agent, and what becomes of them as the code moves.

## Comments and export

Press the `+` that appears next to a line (drag to cover several lines) and write Markdown. What you
write lands in the right-hand rail, which is shut until it has something to hold: it costs 360px of
the code column, which is most of it once the diff is side by side on a laptop. Writing a comment,
focusing one or re-attaching one opens it; so does the *评论* switch at the right of the top bar,
which carries the count and turns violet while any comment is still waiting to go back to the agent,
or has an answer from it you have not dealt with.
`Esc` shuts it again.

Each comment belongs to the `old` or `new` side of the diff and has a status:

- `active` (待导出) — not yet exported
- `exported` (已导出) — copied, or fetched by the agent, at least once (excluded from "copy all" unless
  *含已导出* is checked)
- `orphaned` (已失联) — the code it referred to no longer exists in the current diff

"复制评论" copies every comment of the current target the agent has not had yet (a reviewer reply puts
one back among them); each comment also has a "复制此条" button.
The clipboard format is fixed so an agent can read it directly:

````markdown
# Review comments
Target: working
Repo: /home/user/project
Count: 2

## src/features/order/OrderList.tsx:120-124 (new) [id: 3f2a9c1d]
```tsx
120 | const total = items.reduce((s, i) => s + i.price, 0);
121 | // ...
```
> 这里没有考虑 discount 字段，参考 utils/price.ts 里的 calcTotal。

## src/features/order/hooks/useOrder.ts:42 (new) [id: 8b04e7aa]
```ts
42 | useEffect(() => { fetchOrder(id) }, []);
```
> 依赖数组缺少 id。
Agent replied:
> 已加上，顺带把 fetchOrder 包进了 useCallback。
Reviewer replied:
> useCallback 没必要，去掉。

When you have dealt with a comment, answer it with `warden reply <id> "<what you changed, or why you did not>"` so the reviewer sees your answer beside it.
````

A comment with a thread carries it whole, so a follow-up arrives with what it follows up on. The last
line tells whatever agent the text is pasted into how to answer; it names `npx @xbghc/warden` instead
when warden itself was started through npx. A [todo](#todos) that carries comments is copied the
same way, under its title and body.

## Handing comments to the agent

The clipboard works with any agent, but it leaves the reviewer carrying text back and forth, and the
agent's answer — "done", "not done, because" — nowhere to go but the chat. Two commands let the agent
take the review and answer it in place. Both run in the worktree the agent works in, read and write
the [state file](internals.md#state) directly, and work whether or not a warden page is open:

```sh
warden feedback            # the comments on this worktree it has not had yet, marked as handed over
warden feedback --peek     # the same, marked as nothing
warden reply 8b04e7aa "已加上"   # answer one; the id is the one in its heading
echo "long answer" | warden reply 8b04e7aa
```

`feedback` takes every pool on the worktree it runs in — the local views, `base`, commits, ranges and
checkpoints alike — and prints them in the export format above, reply line included. A worktree
reaches only its own comments: the agent in `<repo>-2` never sees what was said about `<repo>-1`.
A key with no worktree in it always names the main worktree, and a warden started inside a linked
worktree keys that worktree's views by its path, so it does not matter where warden was started.

In the page the answer appears under the comment, which is flagged *待确认* and counted under the
rail's *待确认* filter until you act on it:

- *解决* accepts the answer and deletes the comment — nothing is left for it to ask.
- *回复* is a follow-up. It puts the comment back among those the agent has not had, so the next
  `warden feedback` (or *复制评论*) sends it again with the thread so far.

A comment with a thread is never deleted by a commit (see [Re-anchoring](#re-anchoring)): the
agent's answer usually lands with the very commit that removes the lines it was about, and it would
otherwise go unread. It stays, orphaned, until you resolve it.

To have the agent do this unprompted, tell it so once, in `CLAUDE.md`, `AGENTS.md` or whatever its
instructions file is:

```markdown
When you finish a task, run `warden feedback` (or `npx @xbghc/warden feedback`) and address every
comment it prints. After dealing with each one, run `warden reply <id> "<what you changed, or why
you did not>"`.
```

## Re-anchoring

Every comment stores a hash of its hunk, of each covered line and of three context lines above and
below. On refresh the comment is re-attached in this order: same hunk still present → same relative
position; otherwise search the file for the same line sequence (context lines disambiguate duplicates).

The three local views of a worktree share one pool of comments, and re-anchoring searches all of
them — the comment's current view first, then `working`, `staged`, `all`. So:

- Comment on an unstaged hunk, then `git add` it → the comment turns up in the Staged view,
  unchanged. The card shows which view it moved to; clicking it jumps there.
- The agent edits the commented line → nothing matches, and the comment becomes *orphaned*: listed
  at the top of the rail with its original snippet, ready to be deleted or re-attached to a new selection.
- `git commit` → re-anchoring notices HEAD moved forward. A comment that no longer has a home
  anywhere, and whose lines are in the commits since the last pass, is **deleted** (and unlinked
  from any todo): the code it was about is now history. Anything still visible in Unstaged or Staged
  survives, including as a context line, and so does a comment with replies under it, orphaned,
  until you resolve it.
- Anything else that moves HEAD — a branch switch, `reset`, a stash and checkout, an amend or rebase,
  or a commit that does not carry the commented lines (the agent rewrote them first) — deletes
  nothing: such a comment is orphaned, and comes back when its code does, as after `stash pop`. What
  is left orphaned is yours to delete or re-attach.

Commit, range, `base` and checkpoint targets each keep their own pool and only ever search
themselves, and none of them deletes on a moved HEAD.

Comment markers in the diff belong to one view; the rail's *全部* tab lists the whole pool and
*此文件* lists every comment on the open file regardless of which view it currently sits in.

## Todos

Notes attached to a branch rather than to a line of code, for the things you notice while reviewing
that do not belong in a comment. They are not deleted when you commit. They sit in the right-hand
rail next to the comments, under the *待办* tab, as a task list that works the way Google Tasks does:

- *添加待办* opens an empty row at the top; type the title and press Enter, and the next row opens
  right under it. Esc or Backspace on an empty row drops it.
- Titles and details are edited where they are: click into the text. Enter at the end of a title
  starts the next todo under it; Backspace on an emptied title deletes the todo. The details field
  (Markdown) appears while the row is open, and is rendered under the title otherwise.
- The circle strikes the todo through and files it under *已完成 (N)* at the bottom, collapsed;
  open it to tick one back or *全部删除*.
- Rows are dragged into your own order by the handle at their left edge. That order is what the state
  file keeps, and new todos go on top.
- Delete asks nothing; the toast offers *撤消* for a few seconds.
- The list is the branch checked out where the review is (the main worktree, or the worktree under
  review), and a new todo goes to that branch.

A todo can carry comments: a task and the review notes it is about, handed over together. *加入待办*
on a comment card offers *新建待办* — titled after the comment's first line — or any open todo of
the branch. A todo that carries comments says how many beside its title, and lists them under its
open row, each with *跳转* and *解除关联*. Deleting a comment, or a commit that finishes one, takes it
off the todo as well.

Each row has its own *复制* button, and there is deliberately no "copy all": a todo is one task to
hand to an agent, and the agent it goes to is already working in that branch. So the clipboard gets
the title and the body — no branch, repo, count or numbering:

```markdown
补充 OrderList 的空状态

描述正文（Markdown）…
```

and after them, when the todo carries comments, those comments in the
[export format](#comments-and-export), reply line included. Such a copy is a hand-off like any
other: the comments are marked exported and a checkpoint is taken.

Versions before 0.16 had a separate *Issue* tab; a todo that carries comments is what an issue was,
and the issues an older state file holds are dropped on upgrade.
