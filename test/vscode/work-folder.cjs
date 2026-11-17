const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

/** The workbench lives in the window opened on `<primary>-work`; a window on primary only leads there. */
exports.openWork = (workbench, primary) => {
  const folder = `${primary}-work`;
  if (!fs.existsSync(folder))
    execFileSync('git', ['worktree', 'add', '--quiet', '--detach', '--', folder, 'HEAD'], {
      cwd: primary,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      stdio: 'pipe',
    });
  return workbench.open(folder);
};
