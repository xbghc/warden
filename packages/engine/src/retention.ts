import { runGit, runGitWrite } from './git.js';

/** Older versions pinned trial/source histories in the user's repository. Live source
 * branches and external recovery journals now own those objects instead. Never expire
 * user reflogs or touch references outside the exact namespaces Warden generated.
 */
export async function retireWorkflowRefs(cwd: string): Promise<void> {
  const refs = await runGit(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/warden/changes/', 'refs/warden/deliveries/', 'refs/warden/history/'], {
    cwd,
  });
  for (const line of refs.stdout.trim().split('\n')) {
    const [ref, sha] = line.split(' ');
    if (!ref || !sha || !/^refs\/warden\/(?:changes\/[^/]+\/(?:source|accepted)|deliveries\/[^/]+\/(?:source|commit)|history\/[^/]+)$/.test(ref)) continue;
    await runGitWrite(['update-ref', '-d', ref, sha], { cwd });
  }
}
