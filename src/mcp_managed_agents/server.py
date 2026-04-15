"""FastMCP server assembly."""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from . import tools


def build_server() -> FastMCP:
    mcp = FastMCP("anthropic-managed-agents")

    mcp.tool(description="List all Managed Agents available to the configured API key.")(tools.list_agents)
    mcp.tool(description="List all environments available to the configured API key.")(tools.list_environments)
    mcp.tool(description="Retrieve a session's status, stop_reason, and metadata.")(tools.get_session)
    mcp.tool(description="Return serialized events for a session, optionally after a cursor id.")(tools.list_session_events)
    mcp.tool(description="Create a session bound to an agent and environment.")(tools.create_session)
    mcp.tool(description="Send a user text message to an active session.")(tools.send_message)
    mcp.tool(description="List recent sessions (find duplicates, check state).")(tools.list_active_sessions)
    mcp.tool(
        description=(
            "Retrieve the full final result of any session (past or present). "
            "Paginates through the entire event history so assistant_text is "
            "complete even for long sessions. Use to re-fetch a previously "
            "completed report given its session_id."
        )
    )(tools.get_agent_result)
    mcp.tool(description="Interrupt a running session (sends user.interrupt event).")(tools.interrupt_session)
    mcp.tool(
        description=(
            "Start a Managed Agent run asynchronously and return the session_id "
            "immediately. Use for long-running agents to avoid MCP host timeouts; "
            "then poll with poll_agent_run."
        )
    )(tools.start_agent_run)
    mcp.tool(
        description=(
            "Poll a running agent session. Returns status='running' or 'done' "
            "plus current assistant_text. Safe to call repeatedly."
        )
    )(tools.poll_agent_run)
    # NOTE: run_agent / run_agent_detailed are intentionally NOT registered.
    # They block the MCP call for the full duration of the agent run, which
    # causes host-side timeouts (ADK, LangGraph) to fire and retry, spawning
    # duplicate runs on Anthropic's side. Always use start_agent_run +
    # poll_agent_run instead. If you need the blocking variant for a quick
    # prompt, re-register tools.run_agent below — but know what you're doing.

    return mcp
