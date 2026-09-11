---
name: ui-check
description: Verify a change to the web UI in a real browser — build the bundle, start warden against a throwaway repo with an isolated state file, drive it with Playwright, clean up. Use after editing anything under packages/web whose effect unit tests cannot show (layout, a new panel, a click flow).
---

Everything temporary goes in the session scratchpad directory named in the system prompt (`$SCRATCH` below). Never run the `warden` CLI against a real repository for this: it would write a state file under `~/.local/share/warden`, and a worktree check would create directories beside the real repo.

1. **Build.** From the repo root, `pnpm build:web` (writes `dist/web`). Rebuild after every UI edit and reload the page; the server serves the files as they are on disk.
2. **Throwaway repo.** `git init -q -b main $SCRATCH/demo/repo`, then two or three commits (`git -c user.name=demo -c user.email=demo@example.com commit ...`) plus whatever branches or files the check needs. Worktrees made from it land beside it as `$SCRATCH/demo/repo-<branch>`, so worktree flows are safe to exercise.
3. **Launcher.** Write `$SCRATCH/launch.mts`. It must be `.mts`: the scratchpad has no package.json, so tsx treats `.ts` as CommonJS and rejects top-level await. Import `startServer` from `<absolute repo root>/packages/server/src/index.ts` and call it with `{ repoPath: '$SCRATCH/demo/repo', port: 4100, webDir: '<absolute repo root>/dist/web', stateFile: '$SCRATCH/demo/state.json' }`, logging the returned `url`. Start it from the repo root (`pnpm exec` needs a package there): `nohup pnpm exec tsx $SCRATCH/launch.mts > $SCRATCH/server.log 2>&1 &`, then `curl -s http://127.0.0.1:4100/api/repo` to confirm it answers.
4. **Drive it.** With the Playwright MCP tools: `browser_navigate` to `http://127.0.0.1:4100/`, `browser_find` to get refs (a CSS selector such as `nav[aria-label="面板"] button:nth-of-type(3)` also works as a click target), `browser_click` / `browser_type`, then `browser_take_screenshot` and Read the PNG to judge the result. A 4xx the page handles on purpose (a 409 that opens an inline confirmation, say) shows up as a browser console error: that is the browser logging the response, not a bug.
5. **Clean up, always.** `pkill -f 'launch[.]mts'` (the brackets stop pkill from matching the shell running it), delete the screenshots and the `.playwright-mcp/` directory from the repo root — neither is gitignored — and confirm `git status --short` shows nothing unexpected. The scratchpad can stay.

Report what was exercised and what the screenshots showed, and say plainly if a flow could not be reached.
