#!/usr/bin/env python3
"""PreToolUse hook: refuse commands that clear Bun's shared package cache."""

import json
import re
import sys


COMMAND = re.compile(
    r"(?:^|&&|[;|])\s*"
    r"(?:(?:[^\s;&|]*/)?bunx\s+(?:--bun\s+)?(?:[^\s;&|]*/)?bun\s+|"
    r"(?:[^\s;&|]*/)?bun\s+)"
    r"pm\s+cache\s+(?:rm|clean)(?=$|\s|[;&|])"
)

REASON = (
    "Refused: `bun pm cache rm` and `bun pm cache clean` remove the shared global store "
    "that every isolated-linker node_modules links into. Run `bun install --force` in the "
    "affected checkout, or remove only the one package's manifest from ~/.bun/install/cache."
)


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        if payload.get("tool_name") != "Bash":
            return 0
        command = payload.get("tool_input", {}).get("command", "")
        if not isinstance(command, str) or not COMMAND.search(command):
            return 0
        json.dump(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": REASON,
                }
            },
            sys.stdout,
        )
    except Exception:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
