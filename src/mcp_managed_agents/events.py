"""Event consumption for Managed Agent sessions.

Correct idle-break gate:
  Exit when session.status_terminated fires, OR
  session.status_idle fires AND stop_reason.type != "requires_action".

Defensive extraction: tolerates both the full-event shape
(`agent.message` with a content list) and delta/snapshot shapes
(`agent.message_delta`, `content_block_delta`, etc.) that some
SDK stream helpers emit.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

from anthropic import Anthropic

log = logging.getLogger("mcp_managed_agents.events")


def _to_dict(obj: Any) -> Any:
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, dict):
        return {k: _to_dict(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_to_dict(v) for v in obj]
    if hasattr(obj, "model_dump"):
        try:
            return obj.model_dump()
        except Exception:
            pass
    if hasattr(obj, "to_dict"):
        try:
            return obj.to_dict()
        except Exception:
            pass
    if hasattr(obj, "__dict__"):
        return {k: _to_dict(v) for k, v in vars(obj).items() if not k.startswith("_")}
    return str(obj)


@dataclass
class RunResult:
    session_id: str
    assistant_text: str = ""
    tool_uses: list[str] = field(default_factory=list)
    terminated_reason: str = ""
    timed_out: bool = False
    seen_event_types: list[str] = field(default_factory=list)


def _get(obj: Any, name: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _event_type(event: Any) -> str:
    return str(_get(event, "type", "") or "")


def _extract_text_from_content_blocks(content: Any) -> str:
    """Pull text out of a list of content blocks (text / text delta shapes)."""
    out = ""
    if not content:
        return out
    if isinstance(content, str):
        return content
    if not isinstance(content, (list, tuple)):
        content = [content]
    for block in content:
        btype = _get(block, "type", "")
        # Full text block
        if btype == "text":
            out += str(_get(block, "text", "") or "")
        # Output-text / delta-text variants
        elif btype in ("output_text", "output_text_delta", "text_delta"):
            out += str(_get(block, "text", "") or _get(block, "delta", "") or "")
    return out


def _extract_delta_text(event: Any) -> str:
    """Some events put text under event.delta.text or event.delta.content."""
    delta = _get(event, "delta")
    if delta is None:
        return ""
    if isinstance(delta, str):
        return delta
    text = _get(delta, "text")
    if isinstance(text, str) and text:
        return text
    # content_block_delta shape: {delta: {type: "text_delta", text: "..."}}
    if _get(delta, "type") in ("text_delta", "output_text_delta"):
        return str(_get(delta, "text", "") or "")
    # delta may itself carry a content list
    return _extract_text_from_content_blocks(_get(delta, "content"))


def _absorb_event(event: Any, result: RunResult) -> tuple[bool, str]:
    etype = _event_type(event)
    if etype:
        result.seen_event_types.append(etype)

    # --- Assistant text, full-event shapes ---
    if etype in ("agent.message", "message", "agent.output_text"):
        text = _extract_text_from_content_blocks(_get(event, "content"))
        if not text:
            # Some shapes nest under .message.content
            text = _extract_text_from_content_blocks(_get(_get(event, "message"), "content"))
        if text:
            result.assistant_text += text

    # --- Assistant text, delta/streaming shapes ---
    elif etype in (
        "agent.message_delta",
        "agent.output_text_delta",
        "content_block_delta",
        "message_delta",
        "text_delta",
    ):
        delta_text = _extract_delta_text(event)
        if delta_text:
            result.assistant_text += delta_text

    # --- Tool use ---
    elif etype in ("agent.tool_use", "tool_use"):
        name = _get(event, "name") or _get(event, "tool_name") or _get(_get(event, "tool_use"), "name")
        if name:
            result.tool_uses.append(str(name))

    # --- Terminal states ---
    elif etype == "session.status_terminated":
        reason = _get(_get(event, "stop_reason"), "type") or "terminated"
        return True, str(reason)
    elif etype == "session.status_idle":
        reason = _get(_get(event, "stop_reason"), "type")
        if reason != "requires_action":
            return True, str(reason or "idle")

    return False, ""


def _iter_stream(stream_ctx) -> Any:
    """Yield events from whatever shape the SDK stream helper returns."""
    # Most SDK stream helpers are directly iterable
    try:
        for event in stream_ctx:
            yield event
        return
    except TypeError:
        pass
    # Fallback attribute names
    for attr in ("events", "iter_events", "__iter__"):
        it = getattr(stream_ctx, attr, None)
        if callable(it):
            for event in it():
                yield event
            return


def _final_sweep(
    client: Anthropic,
    session_id: str,
    result: RunResult,
) -> None:
    """After stream ends, list full event history and re-absorb.

    Idempotent-ish for tool_uses (may duplicate) but guarantees we pick up
    the final assistant message even if the stream closed before we saw it.
    Assistant text is replaced wholesale from the history to avoid double-
    counting partial deltas + full message.
    """
    try:
        page = client.beta.sessions.events.list(session_id)
    except Exception as exc:
        log.warning("final events.list failed: %s", exc)
        return
    data = getattr(page, "data", None) or []
    swept_text = ""
    swept_tool_uses: list[str] = []
    swept_reason = ""
    for event in data:
        etype = _event_type(event)
        if etype in ("agent.message", "message", "agent.output_text"):
            text = _extract_text_from_content_blocks(_get(event, "content"))
            if not text:
                text = _extract_text_from_content_blocks(_get(_get(event, "message"), "content"))
            if text:
                swept_text += text
        elif etype in ("agent.tool_use", "tool_use"):
            name = _get(event, "name") or _get(event, "tool_name")
            if name:
                swept_tool_uses.append(str(name))
        elif etype == "session.status_terminated":
            swept_reason = str(_get(_get(event, "stop_reason"), "type") or "terminated")
        elif etype == "session.status_idle":
            reason = _get(_get(event, "stop_reason"), "type")
            if reason != "requires_action":
                swept_reason = str(reason or "idle")
    if swept_text:
        result.assistant_text = swept_text
    if swept_tool_uses:
        result.tool_uses = swept_tool_uses
    if swept_reason and not result.terminated_reason:
        result.terminated_reason = swept_reason


def run_until_idle(
    client: Anthropic,
    session_id: str,
    timeout_s: float = 300.0,
) -> RunResult:
    result = RunResult(session_id=session_id)
    deadline = time.monotonic() + timeout_s
    stream_failed = False

    try:
        ctx = client.beta.sessions.stream(session_id)
        # Support both context-manager and non-cm returns
        if hasattr(ctx, "__enter__"):
            with ctx as stream:
                for event in _iter_stream(stream):
                    if time.monotonic() > deadline:
                        result.timed_out = True
                        result.terminated_reason = "client_timeout"
                        break
                    done, reason = _absorb_event(event, result)
                    if done:
                        result.terminated_reason = reason
                        break
        else:
            for event in _iter_stream(ctx):
                if time.monotonic() > deadline:
                    result.timed_out = True
                    result.terminated_reason = "client_timeout"
                    break
                done, reason = _absorb_event(event, result)
                if done:
                    result.terminated_reason = reason
                    break
    except Exception as exc:
        log.warning("stream failed, falling back to polling: %s", exc)
        stream_failed = True

    # Polling fallback if the stream never completed
    if stream_failed or (not result.terminated_reason and not result.timed_out):
        last_id: str | None = None
        while time.monotonic() < deadline and not result.terminated_reason:
            kwargs = {"after_id": last_id} if last_id else {}
            try:
                page = client.beta.sessions.events.list(session_id, **kwargs)
            except Exception as exc:
                log.warning("events.list poll failed: %s", exc)
                break
            data = getattr(page, "data", None) or []
            for event in data:
                last_id = _get(event, "id") or last_id
                done, reason = _absorb_event(event, result)
                if done:
                    result.terminated_reason = reason
                    break
            if result.terminated_reason:
                break
            if not data:
                time.sleep(1.0)

        if not result.terminated_reason:
            result.timed_out = True
            result.terminated_reason = "client_timeout"

    # Always do a final sweep so the authoritative message list wins over
    # partial stream deltas.
    _final_sweep(client, session_id, result)
    return result


def serialize_event(event: Any) -> dict:
    d = _to_dict(event)
    return d if isinstance(d, dict) else {"raw": d}
