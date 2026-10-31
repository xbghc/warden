import { describe, expect, it } from 'vitest';
import { acpPresets, addAcpPreset, parseAcpProfiles, presetCommandError } from '../packages/vscode/src/acp/profiles.js';

const profile = { id: 'local-agent', label: 'Local agent', command: '/path/to/agent' };

describe('ACP executable profiles', () => {
  it('keeps executable arguments and environment values literal rather than interpolating shell or editor expressions', () => {
    const configured = {
      ...profile,
      command: `/path with spaces/\${agent}/runner`,
      args: ['--acp', '$(echo literal)', `\${workspaceFolder}`, '`literal`', 'argument with spaces', ''],
      env: { AGENT_CONTEXT: `\${workspaceFolder}`, AGENT_OPTION: '$(echo literal)', EMPTY_VALUE: '' },
    };
    expect(parseAcpProfiles([configured])).toEqual([configured]);
  });

  it('supports no configured agent and an executable with no arguments', () => {
    expect(parseAcpProfiles(undefined)).toEqual([]);
    expect(parseAcpProfiles([])).toEqual([]);
    expect(parseAcpProfiles([profile])).toEqual([{ ...profile, args: [] }]);
  });

  it('rejects duplicate identifiers even when they name different executables', () => {
    expect(() => parseAcpProfiles([profile, { ...profile, label: 'Other agent', command: '/another/agent' }])).toThrow('IDs must be unique');
  });

  it.each([
    ['object instead of array', profile],
    ['invalid array entry', [null]],
    ['missing identifier', [{ label: 'Agent', command: '/agent' }]],
    ['identifier with a path separator', [{ ...profile, id: '../agent' }]],
    ['blank label', [{ ...profile, label: '  ' }]],
    ['blank executable', [{ ...profile, command: '  ' }]],
    ['NUL in executable', [{ ...profile, command: '/agent\0--argument' }]],
    ['shell command as argument list', [{ ...profile, args: '--acp --extra' }]],
    ['non-string argument', [{ ...profile, args: [true] }]],
    ['NUL in argument', [{ ...profile, args: ['--acp\0--extra'] }]],
    ['environment array', [{ ...profile, env: ['TOKEN=value'] }]],
    ['invalid environment name', [{ ...profile, env: { 'BAD=NAME': 'value' } }]],
    ['non-string environment value', [{ ...profile, env: { AGENT_FLAG: true } }]],
    ['NUL in environment value', [{ ...profile, env: { AGENT_FLAG: 'a\0b' } }]],
  ])('rejects malformed profiles: %s', (_name, input) => {
    expect(() => parseAcpProfiles(input)).toThrow();
  });
});

describe('ACP configuration presets', () => {
  it('uses an ACP adapter for Codex and the built-in ACP subcommand for OpenCode', () => {
    expect(acpPresets.map(({ id, command, args }) => ({ id, command, args }))).toEqual([
      { id: 'codex', command: 'codex-acp', args: [] },
      { id: 'opencode', command: 'opencode', args: ['acp'] },
    ]);
    expect(addAcpPreset(undefined, 'codex', '/agents/codex-acp')).toEqual([{ id: 'codex', label: 'Codex', command: '/agents/codex-acp', args: [] }]);
  });

  it('appends a preset without normalizing or discarding existing configuration', () => {
    const existing = [{ ...profile, env: { AGENT_TOKEN: 'fixture-only' }, extensionField: 'preserve' }];
    const next = addAcpPreset(existing, 'opencode', '/path with spaces/opencode');
    expect(next).toEqual([...existing, { id: 'opencode', label: 'OpenCode', command: '/path with spaces/opencode', args: ['acp'] }]);
    expect(next[0]).toBe(existing[0]);
    expect(existing).toHaveLength(1);
    expect('args' in existing[0]!).toBe(false);
  });

  it('never replaces an existing preset ID or changes its settings when selected again', () => {
    const existing = [{ ...profile, id: 'codex', args: ['--custom'], env: { CODEX_PATH: '/chosen/codex' } }];
    expect(addAcpPreset(existing, 'codex', '/other/codex-acp')).toBe(existing);
  });

  it('refuses to overwrite invalid settings or exceed the profile limit', () => {
    expect(() => addAcpPreset('invalid', 'codex', 'codex-acp')).toThrow();
    expect(() => addAcpPreset(null, 'codex', 'codex-acp')).toThrow();
    expect(() => addAcpPreset([{ ...profile, args: '--invalid' }], 'codex', 'codex-acp')).toThrow();
    expect(() =>
      addAcpPreset(
        Array.from({ length: 40 }, (_, i) => ({ ...profile, id: `agent-${i}` })),
        'codex',
        'codex-acp',
      ),
    ).toThrow('40');
    expect(() => addAcpPreset([], 'untrusted', 'arbitrary')).toThrow('Unknown ACP preset');
    expect(() => addAcpPreset([], 'opencode', 'bad\0path')).toThrow();
  });

  it('validates native executable input without changing literal paths or invoking a shell', () => {
    expect(presetCommandError('/path with spaces/adapter', 'linux')).toBeUndefined();
    expect(presetCommandError('C:\\Program Files\\agent.exe', 'win32')).toBeUndefined();
    expect(presetCommandError('agent.CMD', 'win32')).toMatch(/native executable/);
    expect(presetCommandError('agent.bat', 'win32')).toMatch(/native executable/);
    for (const value of ['', ' ', 'bad\0path', 'a'.repeat(4001)]) expect(presetCommandError(value, 'linux')).toBeDefined();
  });
});
