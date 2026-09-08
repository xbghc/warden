import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/** How long the Windows side gets to answer. Spawning a Windows process dominates this. */
export const PROBE_TIMEOUT_MS = 3_000;

/** Whether we are running inside WSL, where the browser lives on the other side of the VM boundary. */
export async function isWsl(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform !== 'linux') return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(await readFile('/proc/sys/kernel/osrelease', 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Whether Windows can reach `http://127.0.0.1:<port>/` — a question only Windows can answer, so it
 * is put to `curl.exe` through WSL interop (the same road `explorer.exe` already travels).
 *
 * Under WSL2 the server listens inside the VM while the browser runs on Windows, joined only by the
 * localhost relay. A port that bound cleanly in here can still be dead out there: the relay has to
 * publish it on the Windows side, and that bind fails when a Windows process already holds the port
 * or when it falls inside a Hyper-V reserved range. Neither is visible from inside the VM, which is
 * why `isPortFree` alone is not enough to promise the printed URL will open.
 *
 * `token` is what GET /api/ping echoes. Comparing it rules out the case where the relay lost the
 * port to another Windows process and the probe is cheerfully talking to that one instead.
 *
 * Returns undefined when the probe could not run at all (interop disabled, no `curl.exe`): the
 * caller then knows nothing, which is different from knowing the port is bad.
 */
export function reachableFromWindows(port: number, token: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    execFile(
      'curl.exe',
      ['--silent', '--max-time', String(Math.ceil(timeoutMs / 1000)), `http://127.0.0.1:${port}/api/ping`],
      { timeout: timeoutMs + 1_000, encoding: 'utf8', windowsHide: true },
      (error, stdout) => {
        // A string code is a spawn failure (no interop, no curl.exe); a number is curl's exit code,
        // and every non-zero one of those means it could not fetch — which is an answer, not a gap.
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (typeof code === 'string') {
          resolve(undefined);
          return;
        }
        resolve(stdout.trim() === token);
      },
    );
  });
}
