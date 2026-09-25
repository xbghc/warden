# Editor and platform

Jumping to nvim, and running under WSL2.

## nvim integration

Requirements:

- `nvim` on `PATH` of the machine running warden (WSL2 in the typical setup).
- nvim started normally so it creates its default server socket (`$XDG_RUNTIME_DIR/nvim.<pid>.0`
  or `/tmp/nvim.<user>/…/nvim.<pid>.0`), or with `--listen` into one of those directories.
- nvim's working directory is the repository (or worktree) root or somewhere below it.

warden scans those socket directories, asks each instance for `getcwd()` (500 ms timeout) and keeps the
instances whose cwd is inside the current target's root. One match is used automatically; with several
matches a selector appears in the top bar and the choice is remembered per repository root.

Which instance a click goes to is settled when the click arrives, not by an earlier scan: nvim is
started, quit and restarted while the page stays open. The server tries the selected instance, then
the one remembered for the root, then the only one open there; when the cached scan (10 s) cannot
answer, or the instance it names does not respond, it scans afresh and tries again, so a click
reaches an nvim started after the page loaded, or the one that replaced a restarted editor. An
instance that is still running but refuses the file (`E37`, say) is reported, not bypassed for
another; two instances with none selected are left for you to choose between. The top bar's status
catches up after each click and whenever the browser window regains focus; ⟳ is left for the rare
case that neither happens.

Clicking a line number runs, roughly, `:edit +<line> <absolute path>` in that instance. Deleted lines
jump to the nearest new-side line; for commit targets the working-tree file is opened. With `Alt` held
the click copies the place instead (`src/a.ts:12`), and `Alt`+`Shift` the range from the line last
copied; see the keyboard table in the [README](../README.md#keyboard).

## WSL2 notes

- Access the UI from the Windows browser at the printed `http://127.0.0.1:<port>/` URL; WSL2 forwards
  localhost automatically.
- Install [wslu](https://github.com/wslutilities/wslu) for `wslview` if `explorer.exe` doesn't open the
  URL for you, or run with `--no-open`.
- Keep the repository on the Linux filesystem for reasonable git performance.
- Clipboard access uses `navigator.clipboard`, which works on `localhost`; if you expose the port via
  another hostname the copy button falls back to `document.execCommand('copy')`.
