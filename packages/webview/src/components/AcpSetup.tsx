const example = `{
  "warden.acpAgents": [
    {
      "id": "my-agent",
      "label": "我的 Agent",
      "command": "/absolute/path/to/acp-agent",
      "args": []
    }
  ]
}`;

export function AcpSetup() {
  return (
    <details className="acp-setup">
      <summary>ACP 配置说明与示例</summary>
      <p>先安装支持 ACP v1（stdio）的 Agent 或适配器，并按其文档完成登录。</p>
      <p>
        打开 Agent 设置，在「用户」设置中编辑 <code>warden.acpAgents</code>；SSH、WSL 或容器使用「远程」用户设置。工作区设置中的配置不生效。
      </p>
      <pre>
        <code>{example}</code>
      </pre>
      <p>
        将 <code>command</code> 替换为工作区所在主机上的程序路径，<code>args</code> 按 Agent 文档填写，每个参数单独一个字符串。可选的 <code>env</code>{' '}
        用于设置环境变量。
      </p>
      <p>保存后，在任务的「Agent 对话」中选择 Agent，再点击「连接 Agent」。</p>
    </details>
  );
}
