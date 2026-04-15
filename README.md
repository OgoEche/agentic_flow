# mcp-managed-agents

MCP server wrapping Anthropic's **Managed Agents** (beta) API so any MCP host — Claude Code, LM Studio, LangGraph, Google ADK — can drive managed agents through its own `mcp.json`. The Anthropic API key is held server-side and never crosses the tool-call boundary.

## Install

```bash
pip install -e .
cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY
```

## Run

```bash
# stdio (Claude Code, LM Studio stdio, Google ADK local, LangGraph local)
python -m mcp_managed_agents --transport stdio

# streamable HTTP (remote hosts)
python -m mcp_managed_agents --transport http --host 0.0.0.0 --port 8765
```

The server fails fast if `ANTHROPIC_API_KEY` is missing. Optionally set `ALLOWED_AGENT_IDS` (comma-separated) to restrict which agent ids tools will accept.

## Tools

| Tool | Description |
|---|---|
| `list_agents` | List Managed Agents visible to the key. |
| `list_environments` | List environments visible to the key. |
| `get_session` | Retrieve a session (status, stop_reason, metadata). |
| `list_session_events` | Paginate through session events. |
| `create_session` | Create a session bound to an agent + environment. |
| `send_message` | Send a `user.message` event to a session. |
| `run_agent` | High-level: create session → send prompt → stream until idle-terminal → return aggregate. |

`run_agent` uses the correct idle-break gate: it exits on `session.status_terminated`, or on `session.status_idle` **only when** `stop_reason.type != "requires_action"`.

## Client `mcp.json` snippets

**stdio (Claude Code / LM Studio / Google ADK / local LangGraph):**

```json
{
  "mcpServers": {
    "anthropic-managed-agents": {
      "command": "python",
      "args": ["-m", "mcp_managed_agents", "--transport", "stdio"],
      "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
    }
  }
}
```

**HTTP (remote LangGraph / LM Studio HTTP):**

```json
{
  "mcpServers": {
    "anthropic-managed-agents": {
      "url": "http://localhost:8765/mcp"
    }
  }
}
```

## Security notes

- `ANTHROPIC_API_KEY` is read from the environment / `.env` at startup only. It is **never** accepted as a tool parameter.
- All tool errors are passed through a redactor that strips `sk-ant-…` substrings and the configured key value before returning.
- Set `ALLOWED_AGENT_IDS` to limit blast radius if an MCP client is compromised.
