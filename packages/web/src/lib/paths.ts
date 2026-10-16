import { isWindowsAbsolutePath } from '@warden/shared';

/** Last segment of a directory path: what a checkout is called, in the top bar and in the tab title. */
export function dirName(path: string): string {
  return (
    path
      .split(isWindowsAbsolutePath(path) ? /[\\/]/ : '/')
      .filter(Boolean)
      .pop() ?? path
  );
}
