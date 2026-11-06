import { writeFileSync } from 'node:fs';

// A foreground installer can ignore graceful signals and keep changing the workspace.
process.on('SIGTERM', () => {});
writeFileSync('setup-child.pid', String(process.pid));
let version = 0;
const write = () => writeFileSync('setup-child-output.txt', String(++version));
write();
setInterval(write, 20);
if (process.argv[2] === 'stdout') process.stdout.write('x'.repeat(129 * 1024));
if (process.argv[2] === 'stderr') process.stderr.write('x'.repeat(129 * 1024));
