// Inherited Git variables can redirect writes out of a fixture repository, including
// its index, object store and trace files. Clear them before any test spawns Git.
for (const name of Object.keys(process.env)) {
  if (name.toUpperCase().startsWith('GIT_')) delete process.env[name];
}

// Git for Windows also understands /dev/null. User and system configuration must
// not hide missing fixture setup or install hooks, filters or signing commands.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';
