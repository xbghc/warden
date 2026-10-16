# Platform

## WSL2 notes

- Access the UI from the Windows browser at the printed `http://127.0.0.1:<port>/` URL; WSL2 forwards
  localhost automatically.
- Install [wslu](https://github.com/wslutilities/wslu) for `wslview` if `explorer.exe` doesn't open the
  URL for you, or run with `--no-open`.
- Keep the repository on the Linux filesystem for reasonable git performance.
- Clipboard access uses `navigator.clipboard`, which works on `localhost`; if you expose the port via
  another hostname the copy button falls back to `document.execCommand('copy')`.
