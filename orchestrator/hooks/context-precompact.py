#!/usr/bin/env python3
"""PreCompact hook reserved for compaction context capture."""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from registered_scope import should_hook_act


def main():
    payload = json.load(sys.stdin)
    if not should_hook_act(payload):
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
