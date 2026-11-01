import type { ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { AcpMessage } from '@warden/shared';

export interface ToolDisplay {
  title: string;
  content: string;
  output?: string;
  exit?: string;
  exitCode?: number;
  exitSignal?: string;
  terminal?: boolean;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Ending a turn or replaying history cannot establish whether an agent-owned command is still running. */
export function markUnsettledTools(messages: AcpMessage[]) {
  for (const message of messages) if (message.role === 'tool' && (message.status === 'pending' || message.status === 'in_progress')) message.uncertain = true;
}

/** These ACP v1 conventions report agent-owned commands; they never grant client terminal access. */
export function updateToolOutput(display: ToolDisplay, update: ToolCallUpdate, bounded: (value: string) => string) {
  const meta = update._meta;
  const chunk = meta?.terminal_output_delta ?? meta?.terminal_output;
  // A chunk from another terminal cannot be attached to this tool, even in a valid session.
  if (object(chunk) && chunk.terminal_id === update.toolCallId && typeof chunk.data === 'string') display.output = bounded((display.output ?? '') + chunk.data);

  const terminal = meta?.terminal_exit;
  const exit = object(terminal) && terminal.terminal_id === update.toolCallId ? terminal : undefined;
  const raw = object(update.rawOutput) ? update.rawOutput : undefined;
  const code = exit?.exit_code ?? raw?.exit_code;
  if (typeof code === 'number' && Number.isSafeInteger(code)) {
    display.exitCode = code;
    delete display.exitSignal;
    display.exit = `Exit code: ${code}`;
  } else if (exit && typeof exit.signal === 'string' && exit.signal) {
    display.exitSignal = bounded(exit.signal).slice(0, 128);
    delete display.exitCode;
    display.exit = `Signal: ${display.exitSignal}`;
  }
}
