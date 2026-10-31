const example = `{
  "warden.acpAgents": [
    {
      "id": "my-agent",
      "label": "My Agent",
      "command": "/absolute/path/to/acp-agent",
      "args": []
    }
  ]
}`;

export function AcpSetup() {
  return (
    <details className="acp-setup">
      <summary>ACP Setup Guide and Example</summary>
      <p>Choose Configure Agent, select Codex or OpenCode, then confirm its executable on the workspace host. Warden saves the preset for you.</p>
      <ul className="list-disc pl-5">
        <li>
          <strong>Codex:</strong> install the{' '}
          <a className="underline underline-offset-2" href="https://github.com/agentclientprotocol/codex-acp">
            codex-acp adapter
          </a>
          , then use <code>codex-acp</code>. The regular <code>codex</code> command does not speak ACP.
        </li>
        <li>
          <strong>OpenCode:</strong> install{' '}
          <a className="underline underline-offset-2" href="https://docs.opencode.ai/docs/acp/">
            OpenCode
          </a>
          , then use <code>opencode</code> with the preset <code>acp</code> argument.
        </li>
      </ul>
      <p>Install and authenticate on the same host as the workspace. Adding a preset saves settings; it does not install or start the agent.</p>
      <p>On Windows, choose a native executable (.exe). For a Node.js script or batch wrapper, use Custom Agent / Edit Settings to configure its launcher.</p>
      <p>
        Choose Custom Agent / Edit Settings for other agents, arguments or environment variables. Edit <code>warden.acpAgents</code> in User settings, or Remote
        User settings for SSH, WSL or containers. Workspace settings are ignored. Existing profiles are kept when adding a preset.
      </p>
      <pre>
        <code>{example}</code>
      </pre>
      <p>
        Replace <code>command</code> with the executable path on the workspace host. Set <code>args</code> according to the agent documentation, using one
        string per argument. Optional <code>env</code> entries set environment variables.
      </p>
      <p>Save the settings, select an agent in the task conversation, then choose Connect Agent.</p>
    </details>
  );
}
