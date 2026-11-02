import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { acpPresets, addAcpPreset, parseAcpProfiles, presetCommandError } from '../packages/vscode/src/acp/profiles.js';

const profile = { id: 'local-agent', label: 'Local agent', command: '/path/to/agent' };

describe('ACP executable profiles', () => {
  it('accepts named Zed and JetBrains agent entries with stable names and optional labels', () => {
    expect(
      parseAcpProfiles({
        'My Agent': { type: 'custom', command: '/agent', args: ['acp'], env: { OPTION: 'literal' } },
        'local-agent': { label: 'Renamed display', command: '/other' },
      }),
    ).toEqual([
      { id: 'My Agent', label: 'My Agent', command: '/agent', args: ['acp'], env: { OPTION: 'literal' } },
      { id: 'local-agent', label: 'Renamed display', command: '/other', args: [] },
    ]);
    expect(parseAcpProfiles({ 'local-agent': { label: profile.label, command: profile.command } })).toEqual(parseAcpProfiles([profile]));
    expect(parseAcpProfiles({})).toEqual([]);
  });

  it('ships a valid commented custom-agent example', () => {
    const file = new URL('../packages/vscode/examples/acp-agents.jsonc', import.meta.url);
    const parsed = ts.parseConfigFileTextToJson(file.pathname, readFileSync(file, 'utf8'));
    expect(parsed.error).toBeUndefined();
    expect(parseAcpProfiles(parsed.config['warden.acpAgents'])).toMatchObject([{ id: 'my-agent', command: '/absolute/path/to/acp-agent', args: [] }]);
  });

  it.each([
    { '': { command: '/agent' } },
    { '   ': { command: '/agent' } },
    { 'bad\nname': { command: '/agent' } },
    { ['x'.repeat(101)]: { command: '/agent' } },
    { agent: null },
    { agent: [] },
    { agent: { command: ' ' } },
    { agent: { command: '/agent', label: null } },
    { agent: { command: '/agent', args: '--acp' } },
    { agent: { command: '/agent', env: { OPTION: true } } },
    { agent: { command: '/agent', id: 'another-identity' } },
    { agent: { command: '/agent', type: 'registry' } },
    { agent: { command: '/agent', use_idea_mcp: true } },
    { agent_servers: { agent: { command: '/agent' } } },
    Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`agent-${i}`, { command: '/agent' }])),
  ])('rejects malformed or unsupported named profiles: %j', (value) => {
    expect(() => parseAcpProfiles(value)).toThrow();
  });

  it('keeps executable arguments and environment values literal rather than interpolating shell or editor expressions', () => {
    const configured = {
      ...profile,
      command: `/path with spaces/\${agent}/runner`,
      args: ['--acp', '$(echo literal)', `\${workspaceFolder}`, '`literal`', 'argument with spaces', ''],
      env: { AGENT_CONTEXT: `\${workspaceFolder}`, AGENT_OPTION: '$(echo literal)', EMPTY_VALUE: '' },
    };
    expect(parseAcpProfiles([configured])).toEqual([configured]);
    const { id, ...options } = configured;
    expect(parseAcpProfiles({ [id]: options })).toEqual([configured]);
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
    ['unkeyed profile object', profile],
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
    expect(addAcpPreset(undefined, 'codex', '/agents/codex-acp')).toEqual({ codex: { label: 'Codex', command: '/agents/codex-acp', args: [] } });
  });

  it('preserves named profiles and their format when adding or reselecting presets', () => {
    const existing = { 'My Agent': { type: 'custom', command: '/agent', env: { OPTION: 'keep' } } };
    const next = addAcpPreset(existing, 'opencode', '/opencode');
    expect(next).toEqual({ ...existing, opencode: { label: 'OpenCode', command: '/opencode', args: ['acp'] } });
    expect(addAcpPreset(next, 'opencode', '/different')).toBe(next);
    expect(parseAcpProfiles(existing)).toHaveLength(1);
    expect(() => addAcpPreset({ agent: { command: '/agent', use_idea_mcp: true } }, 'codex', '/codex')).toThrow('Unsupported');
  });

  it('appends a preset without normalizing or discarding existing configuration', () => {
    const existing = [{ ...profile, env: { AGENT_TOKEN: 'fixture-only' }, extensionField: 'preserve' }];
    const next = addAcpPreset(existing, 'opencode', '/path with spaces/opencode');
    expect(next).toEqual([...existing, { id: 'opencode', label: 'OpenCode', command: '/path with spaces/opencode', args: ['acp'] }]);
    expect(Array.isArray(next) ? next[0] : undefined).toBe(existing[0]);
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
