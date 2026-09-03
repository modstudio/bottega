#!/usr/bin/env python3
"""SessionStart hook: place the operator's brief for this checkout in context."""
import json
import os
import subprocess
import sys


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        cwd = payload.get("cwd")
        if not cwd:
            return 0
        orch = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "bin", "orch"))
        result = subprocess.run(
            [orch, "doc", "brief", "--cwd", cwd],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            check=False,
            timeout=10,
        )
        if result.returncode == 0:
            sys.stdout.write(result.stdout)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
