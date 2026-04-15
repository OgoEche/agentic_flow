"""Anthropic client singleton and key redaction."""

from __future__ import annotations

import os
import re
from functools import lru_cache

from anthropic import Anthropic

_KEY_PATTERN = re.compile(r"sk-ant-[A-Za-z0-9_\-]+")


class ConfigError(RuntimeError):
    """Raised when required config is missing."""


@lru_cache(maxsize=1)
def get_anthropic() -> Anthropic:
    """Return a process-wide Anthropic client.

    Reads ANTHROPIC_API_KEY from the environment. Fails fast if missing.
    The SDK auto-attaches the managed-agents-2026-04-01 beta header for
    client.beta.{agents,environments,sessions,vaults}.* calls.
    """
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise ConfigError(
            "ANTHROPIC_API_KEY is not set. Configure it in the environment "
            "or a .env file before launching the MCP server."
        )
    return Anthropic(api_key=key)


def get_allowed_agent_ids() -> set[str] | None:
    """Optional operator allowlist for agent_id arguments.

    Returns None if unset (all agents allowed), otherwise a set of ids.
    """
    raw = os.environ.get("ALLOWED_AGENT_IDS", "").strip()
    if not raw:
        return None
    return {p.strip() for p in raw.split(",") if p.strip()}


def check_agent_allowed(agent_id: str) -> None:
    allow = get_allowed_agent_ids()
    if allow is not None and agent_id not in allow:
        raise PermissionError(
            f"agent_id not in ALLOWED_AGENT_IDS allowlist: {agent_id}"
        )


def redact(message: str) -> str:
    """Strip API key substrings from a string before it leaves the server."""
    if not message:
        return message
    redacted = _KEY_PATTERN.sub("sk-ant-***REDACTED***", message)
    live_key = os.environ.get("ANTHROPIC_API_KEY")
    if live_key and len(live_key) > 8 and live_key in redacted:
        redacted = redacted.replace(live_key, "***REDACTED***")
    return redacted
