import { describe, expect, it } from 'vitest';
import { isWsl } from './wsl.js';

describe('isWsl', () => {
  it('is false off linux, whatever the environment claims', async () => {
    expect(await isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, 'win32')).toBe(false);
    expect(await isWsl({ WSL_INTEROP: '/run/WSL/8_interop' }, 'darwin')).toBe(false);
  });

  it('trusts the WSL environment variables on linux', async () => {
    expect(await isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, 'linux')).toBe(true);
    expect(await isWsl({ WSL_INTEROP: '/run/WSL/8_interop' }, 'linux')).toBe(true);
  });

  // Without the WSL variables the answer comes from /proc/sys/kernel/osrelease, which only says
  // "microsoft" under WSL. Where that file does not exist the call answers false instead of throwing.
  it.skipIf(process.platform === 'linux')('answers false when the kernel release cannot be read', async () => {
    await expect(isWsl({}, 'linux')).resolves.toBe(false);
  });
});
