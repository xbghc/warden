import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { release } from 'node:os';
import { fileURLToPath } from 'node:url';

declare const __WARDEN_BUNDLED__: boolean | undefined;

export interface NativeWorktreeState {
  head?: string;
  branch?: string;
  dirtyCount: number;
  statusFingerprint: string;
  paths: string[];
}

export interface NativeGitError {
  kind: 'timeout' | 'missing_git' | 'missing_worktree' | 'failed' | 'invalid_output' | 'output_limit' | 'io';
  message: string;
  stderr: string;
  exitCode?: number;
}

export interface NativeBinding {
  readWorktreeState(cwd: string, environment: Record<string, string>): Promise<{ state?: NativeWorktreeState; error?: NativeGitError }>;
}

let binding: NativeBinding | undefined;
let detectedTarget: string | null | undefined;

/** These are the targets built and tested by CI and included together in the npm package. */
function nativeTarget(): string | null {
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64-msvc';
  if (process.arch !== 'x64' && process.arch !== 'arm64') return null;
  if (process.platform === 'darwin') return Number.parseInt(release(), 10) >= 20 ? `darwin-${process.arch}` : null;
  if (process.platform !== 'linux') return null;

  // Linux release artifacts use Ubuntu 22.04 (glibc 2.35). Musl and older glibc use the CLI
  // implementation, even when a same-architecture GNU artifact is present in the package.
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
  const version = report.header?.glibcVersionRuntime?.split('.').map(Number);
  if (!version || version[0]! < 2 || (version[0] === 2 && version[1]! < 35)) return null;
  return `linux-${process.arch}-gnu`;
}

export function loadNativeBinding(): NativeBinding | null {
  if (process.env.WARDEN_NATIVE === 'disabled') return null;
  if (binding) return binding;
  if (detectedTarget === undefined) detectedTarget = nativeTarget();
  const target = detectedTarget;
  const bundled = typeof __WARDEN_BUNDLED__ !== 'undefined' && __WARDEN_BUNDLED__;
  const directory = new URL(bundled ? './native/' : '../../../native/', import.meta.url);
  const filename = target ? fileURLToPath(new URL(`warden.${target}.node`, directory)) : null;
  if (!filename || !existsSync(filename)) {
    if (process.env.WARDEN_NATIVE === 'required') {
      throw new Error(filename ? `Warden native module is missing: ${filename}. Run pnpm build:native.` : 'Warden has no native build for this platform.');
    }
    return null;
  }

  // A missing target can use the compatibility path. An existing but unloadable artifact is a
  // packaging/runtime error, which must remain visible instead of silently hiding broken builds.
  const loaded = createRequire(import.meta.url)(filename) as NativeBinding;
  if (typeof loaded.readWorktreeState !== 'function') throw new Error(`Invalid Warden native module: ${filename}`);
  binding = loaded;
  return binding;
}
