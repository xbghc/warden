import os from 'node:os';

/** Clock steps around startup stay well inside this margin; live owners refresh far more often. */
const BOOT_MARGIN_MS = 60_000;

/**
 * A process ID proves little after a restart: the number is handed out again, and a signal to
 * someone else's process reports "exists". A record last written before this host booted cannot
 * belong to anything still running, whatever now holds its PID.
 */
export function writtenBeforeBoot(writtenAt: number | string | undefined): boolean {
  const time = typeof writtenAt === 'string' ? Date.parse(writtenAt) : writtenAt;
  return typeof time === 'number' && Number.isFinite(time) && time < Date.now() - os.uptime() * 1000 - BOOT_MARGIN_MS;
}

/** True only when the process is known to be gone; uncertain status stays occupied. */
export function processExited(pid: number, writtenAt?: number | string): boolean {
  if (writtenBeforeBoot(writtenAt)) return true;
  if (!Number.isSafeInteger(pid) || pid === 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
