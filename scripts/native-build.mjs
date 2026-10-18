import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = join(root, 'native');
const destination = join(root, 'dist', 'native');
const platform = {
  'linux-x64': ['linux-x64-gnu', 'x86_64-unknown-linux-gnu', 'libwarden_node.so'],
  'linux-arm64': ['linux-arm64-gnu', 'aarch64-unknown-linux-gnu', 'libwarden_node.so'],
  'darwin-x64': ['darwin-x64', 'x86_64-apple-darwin', 'libwarden_node.dylib'],
  'darwin-arm64': ['darwin-arm64', 'aarch64-apple-darwin', 'libwarden_node.dylib'],
  'win32-x64': ['win32-x64-msvc', 'x86_64-pc-windows-msvc', 'warden_node.dll'],
}[`${process.platform}-${process.arch}`];
if (!platform) throw new Error(`Native builds are not configured for ${process.platform}-${process.arch}.`);
const [target, triple, library] = platform;
const filename = `warden.${target}.node`;

function copyArtifact(source, destination) {
  // An existing Node process can have the library memory-mapped. Replacing the directory entry
  // keeps that process's old image intact; truncating the loaded file can crash it during a rebuild.
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    copyFileSync(source, temporary);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

if (!process.argv.includes('--copy-only') && process.env.WARDEN_NATIVE_PREBUILT !== '1') {
  const environment = { ...process.env };
  // Pin the deployment floor when using newer macOS SDKs in CI.
  if (process.platform === 'darwin') environment.MACOSX_DEPLOYMENT_TARGET = '11.0';
  // Bundle the MSVC runtime so installing Warden does not also require Visual Studio's runtime.
  // Keep any developer-supplied compiler flags and change only this Cargo child process.
  if (process.platform === 'win32') {
    if (environment.CARGO_ENCODED_RUSTFLAGS !== undefined)
      environment.CARGO_ENCODED_RUSTFLAGS = [environment.CARGO_ENCODED_RUSTFLAGS, '-C', 'target-feature=+crt-static'].filter(Boolean).join('\u001f');
    else environment.RUSTFLAGS = `${environment.RUSTFLAGS ?? ''} -C target-feature=+crt-static`.trim();
  }
  const result = spawnSync('cargo', ['build', '--locked', '--release', '--package', 'warden-node', '--target', triple], {
    cwd: root,
    stdio: 'inherit',
    env: environment,
  });
  if (result.error)
    throw new Error('Cannot build the Rust core. Install the toolchain in rust-toolchain.toml and run pnpm build:native.', { cause: result.error });
  if (result.status !== 0) process.exit(result.status ?? 1);
  mkdirSync(artifacts, { recursive: true });
  const cargoTarget = resolve(root, process.env.CARGO_TARGET_DIR ?? 'target');
  copyArtifact(join(cargoTarget, triple, 'release', library), join(artifacts, filename));
}

if (!existsSync(join(artifacts, filename))) throw new Error(`Missing native artifact ${filename}. Run pnpm build:native or download the CI artifacts first.`);
mkdirSync(destination, { recursive: true });
for (const entry of readdirSync(artifacts)) {
  if (entry.startsWith('warden.') && entry.endsWith('.node')) copyArtifact(join(artifacts, entry), join(destination, entry));
}
console.log(`Native module ready: ${filename}`);
