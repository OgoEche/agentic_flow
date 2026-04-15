"""MCP tool implementations wrapping client.beta.* Managed Agents calls."""

from __future__ import annotations

import functools
from typing import Any

from .client import check_agent_allowed, get_anthropic, redact
from .events import _to_dict, run_until_idle, serialize_event


def _safe(fn):
    """Wrap a tool so upstream errors are redacted before leaving the server.

    Uses functools.wraps so FastMCP's inspect.signature() follows __wrapped__
    back to the real function and generates the correct input schema.
    """
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:
            raise RuntimeError(redact(f"{type(exc).__name__}: {exc}")) from None
    return wrapper


@_safe
def list_agents() -> list[dict]:
    """List all Managed Agents available to the configured API key."""
    client = get_anthropic()
    page = client.beta.agents.list()
    data = getattr(page, "data", None) or []
    return [_to_dict(a) for a in data]


@_safe
def list_environments() -> list[dict]:
    """List all environments available to the configured API key."""
    client = get_anthropic()
    page = client.beta.environments.list()
    data = getattr(page, "data", None) or []
    return [_to_dict(e) for e in data]


@_safe
def get_session(session_id: str) -> dict:
    """Retrieve a session by id (status, stop_reason, metadata, ...)."""
    client = get_anthropic()
    return _to_dict(client.beta.sessions.retrieve(session_id))


@_safe
def list_session_events(
    session_id: str,
    after_id: str | None = None,
    limit: int = 100,
) -> list[dict]:
    """Return serialized events for a session, optionally after a cursor."""
    client = get_anthropic()
    kwargs: dict[str, Any] = {"limit": limit}
    if after_id:
        kwargs["after_id"] = after_id
    page = client.beta.sessions.events.list(session_id, **kwargs)
    data = getattr(page, "data", None) or []
    return [serialize_event(e) for e in data]


@_safe
def create_session(
    agent_id: str,
    environment_id: str,
    metadata: dict | None = None,
) -> dict:
    """Create a session bound to an agent and environment."""
    check_agent_allowed(agent_id)
    client = get_anthropic()
    kwargs: dict[str, Any] = {"agent": agent_id, "environment_id": environment_id}
    if metadata:
        kwargs["metadata"] = metadata
    session = client.beta.sessions.create(**kwargs)
    return _to_dict(session)


@_safe
def send_message(session_id: str, text: str) -> dict:
    """Send a user text message to an active session."""
    client = get_anthropic()
    client.beta.sessions.events.send(
        session_id,
        events=[{"type": "user.message", "content": [{"type": "text", "text": text}]}],
    )
    return {"accepted": True, "session_id": session_id}


@_safe
def get_agent_result(session_id: str) -> dict:
    """Retrieve the full, final result of any session (past or present).

    Paginates through the entire event history so the returned
    assistant_text is complete even for long research sessions.
    Safe to call on sessions that finished days ago — results persist
    on Anthropic's side.

    Returns:
      {session_id, session_status, terminated_reason,
       assistant_text, tool_uses, total_events}
    """
    from .events import _absorb_event, RunResult
    client = get_anthropic()

    session = client.beta.sessions.retrieve(session_id)
    raw_status = str(_get_attr(session, "status", "") or "").lower()
    stop_reason = _get_attr(session, "stop_reason")
    stop_reason_type = str(_get_attr(stop_reason, "type", "") or "") if stop_reason else ""

    result = RunResult(session_id=session_id)
    total = 0
    after_id: str | None = None
    while True:
        kwargs = {"limit": 100}
        if after_id:
            kwargs["after_id"] = after_id
        page = client.beta.sessions.events.list(session_id, **kwargs)
        data = getattr(page, "data", None) or []
        if not data:
            break
        for event in data:
            _absorb_event(event, result)
            after_id = _get_attr(event, "id") or after_id
            total += 1
        has_more = getattr(page, "has_more", False) or (len(data) >= 100)
        if not has_more:
            break

    return {
        "session_id": session_id,
        "session_status": raw_status,
        "terminated_reason": stop_reason_type,
        "assistant_text": result.assistant_text,
        "tool_uses": result.tool_uses,
        "total_events": total,
    }


@_safe
def list_active_sessions(limit: int = 20) -> list[dict]:
    """List recent sessions so you can find duplicates and kill them."""
    client = get_anthropic()
    page = client.beta.sessions.list(limit=limit)
    data = getattr(page, "data", None) or []
    return [_to_dict(s) for s in data]


@_safe
def interrupt_session(session_id: str) -> dict:
    """Send a user.interrupt event to stop a runaway session mid-flight."""
    client = get_anthropic()
    client.beta.sessions.events.send(
        session_id,
        events=[{"type": "user.interrupt"}],
    )
    return {"interrupted": True, "session_id": session_id}


@_safe
def start_agent_run(
    agent_id: str,
    environment_id: str,
    prompt: str,
) -> dict:
    """Start a Managed Agent run and return immediately.

    Use this for long-running agents (deep research, multi-step coding) to
    avoid the MCP host's request timeout. Poll poll_agent_run(session_id)
    until status == "done".
    """
    check_agent_allowed(agent_id)
    client = get_anthropic()
    session = client.beta.sessions.create(agent=agent_id, environment_id=environment_id)
    session_id = getattr(session, "id", None) or _to_dict(session).get("id")
    if not session_id:
        raise RuntimeError("sessions.create did not return an id")
    client.beta.sessions.events.send(
        session_id,
        events=[{"type": "user.message", "content": [{"type": "text", "text": prompt}]}],
    )
    return {"session_id": session_id, "status": "running"}


@_safe
def poll_agent_run(session_id: str) -> dict:
    """Poll a running agent session and return current state.

    Primary signal: the session's own `status` and `stop_reason`
    (client.beta.sessions.retrieve). Done when:
      - status == "terminated", OR
      - status == "idle" AND stop_reason.type != "requires_action"

    assistant_text and tool_uses are aggregated from the event history.

    Safe to call repeatedly. Call every ~5-15s until status == "done".
    """
    from .events import _absorb_event, RunResult
    client = get_anthropic()

    # Authoritative session state
    session = client.beta.sessions.retrieve(session_id)
    raw_status = str(_get_attr(session, "status", "") or "").lower()
    stop_reason_type = ""
    stop_reason = _get_attr(session, "stop_reason")
    if stop_reason is not None:
        stop_reason_type = str(_get_attr(stop_reason, "type", "") or "")

    done = False
    if raw_status == "terminated":
        done = True
    elif raw_status == "idle" and stop_reason_type != "requires_action":
        done = True

    # Aggregate text from event history
    page = client.beta.sessions.events.list(session_id)
    data = getattr(page, "data", None) or []
    result = RunResult(session_id=session_id)
    for event in data:
        _absorb_event(event, result)

    return {
        "session_id": session_id,
        "status": "done" if done else "running",
        "session_status": raw_status,
        "terminated_reason": stop_reason_type,
        "assistant_text": result.assistant_text,
        "tool_uses": result.tool_uses,
    }


def _get_attr(obj, name, default=None):
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _run_agent_core(
    agent_id: str,
    environment_id: str,
    prompt: str,
    timeout_s: float,
):
    check_agent_allowed(agent_id)
    client = get_anthropic()
    session = client.beta.sessions.create(agent=agent_id, environment_id=environment_id)
    session_id = getattr(session, "id", None) or _to_dict(session).get("id")
    if not session_id:
        raise RuntimeError("sessions.create did not return an id")
    client.beta.sessions.events.send(
        session_id,
        events=[{"type": "user.message", "content": [{"type": "text", "text": prompt}]}],
    )
    return run_until_idle(client, session_id, timeout_s=timeout_s)


@_safe
def run_agent(
    agent_id: str,
    environment_id: str,
    prompt: str,
    timeout_s: float = 300.0,
) -> str:
    """Run a Managed Agent to completion and return its assistant reply as plain text.

    Use run_agent_detailed if you need tool-use names, termination reason,
    or the session id alongside the text.
    """
    result = _run_agent_core(agent_id, environment_id, prompt, timeout_s)
    if result.timed_out and not result.assistant_text:
        raise RuntimeError(
            f"run_agent timed out after {timeout_s}s with no assistant output "
            f"(session {result.session_id})."
        )
    return result.assistant_text or ""


@_safe
def run_agent_detailed(
    agent_id: str,
    environment_id: str,
    prompt: str,
    timeout_s: float = 300.0,
) -> dict:
    """Same as run_agent but returns session_id, tool_uses, and termination reason."""
    result = _run_agent_core(agent_id, environment_id, prompt, timeout_s)
    return {
        "session_id": result.session_id,
        "assistant_text": result.assistant_text,
        "tool_uses": result.tool_uses,
        "terminated_reason": result.terminated_reason,
        "timed_out": result.timed_out,
    }
