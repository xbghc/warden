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
      <p>Install an agent or adapter supporting ACP v1 over stdio, then authenticate as described in its documentation.</p>
      <p>
        Open Agent settings and edit <code>warden.acpAgents</code> in User settings, or Remote User settings for SSH, WSL or containers. Workspace settings are
        ignored.
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
