import { addReply, formatCommentsExport, HttpError, resolveRepo, shortId, StateStore, stateFilePath, takeFeedback } from '@warden/server';

// The commands an agent runs, in the worktree it works in. They read and write the review state
// directly, so they work whether or not a warden page is open.

export const AGENT_COMMANDS = ['feedback', 'reply'] as const;

export function agentUsage(cmd: string): string {
  return `Commands for the agent, run inside the worktree under review:
  ${cmd} feedback [--peek]      Print the review comments not yet handed over, and mark them handed
                               over (--peek leaves them as they are)
  ${cmd} reply <id> <message>   Answer a comment; <id> is the one in its heading. A message of "-",
                               or none with stdin piped, is read from stdin
`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function openStore(): Promise<{ store: StateStore; root: string; commonRoot: string }> {
  const repo = await resolveRepo(process.cwd());
  return { store: new StateStore(stateFilePath(repo.commonRoot), repo.commonRoot), root: repo.root, commonRoot: repo.commonRoot };
}

async function feedback(args: string[], replyCommand: string): Promise<void> {
  const unknown = args.find((a) => a !== '--peek');
  if (unknown) throw new Error(`unknown argument: ${unknown}`);
  const { store, root, commonRoot } = await openStore();
  const comments = await takeFeedback(store, { worktreeRoot: root, mainRoot: commonRoot, peek: args.includes('--peek') });
  if (comments.length === 0) {
    console.log('No review comments are waiting for you.');
    return;
  }
  process.stdout.write(formatCommentsExport({ repoRoot: root, comments, replyCommand }));
}

async function reply(args: string[]): Promise<void> {
  const [id, ...words] = args;
  if (!id) throw new Error('reply needs a comment id');
  let body = words.join(' ');
  if (body === '-' || (!body && !process.stdin.isTTY)) body = await readStdin();
  if (!body.trim()) throw new Error('reply needs a message');
  const { store } = await openStore();
  const c = await addReply(store, id, 'agent', body);
  const range = c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}-${c.endLine}`;
  console.log(`Replied to ${shortId(c.id)} (${c.filePath}:${range}).`);
}

/** Runs `argv` when it names an agent command and returns the exit code; undefined when it does not. */
export async function runAgentCommand(argv: string[], replyCommand: string): Promise<number | undefined> {
  const [cmd, ...rest] = argv;
  if (!cmd || !(AGENT_COMMANDS as readonly string[]).includes(cmd)) return undefined;
  try {
    if (cmd === 'feedback') await feedback(rest, replyCommand);
    else await reply(rest);
    return 0;
  } catch (e) {
    console.error(`warden ${cmd}: ${e instanceof HttpError || e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
