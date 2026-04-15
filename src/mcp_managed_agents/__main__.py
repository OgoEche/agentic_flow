"""CLI entry point."""

from __future__ import annotations

import argparse
import sys

from dotenv import load_dotenv

from .client import ConfigError, get_anthropic
from .server import build_server


def main() -> int:
    parser = argparse.ArgumentParser(prog="mcp-managed-agents")
    parser.add_argument(
        "--transport",
        choices=["stdio", "http"],
        default="stdio",
        help="MCP transport (default: stdio)",
    )
    parser.add_argument("--host", default="127.0.0.1", help="HTTP bind host")
    parser.add_argument("--port", type=int, default=8765, help="HTTP bind port")
    args = parser.parse_args()

    load_dotenv()

    # Fail fast if the key is missing (cached client is built here).
    try:
        get_anthropic()
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    mcp = build_server()

    if args.transport == "stdio":
        mcp.run(transport="stdio")
    else:
        mcp.settings.host = args.host
        mcp.settings.port = args.port
        mcp.run(transport="streamable-http")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
