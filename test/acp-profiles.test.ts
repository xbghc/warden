import { describe, expect, it } from 'vitest';
import { parseAcpProfiles } from '../packages/vscode/src/acp/profiles.js';

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
    expect(() => parseAcpProfiles([profile, { ...profile, label: 'Other agent', command: '/another/agent' }])).toThrow('id 必须唯一');
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
