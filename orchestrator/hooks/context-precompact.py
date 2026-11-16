#!/usr/bin/env python3
"""Ask compaction to preserve unstored facts and pointers."""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from registered_scope import orch_worker_session
from registered_scope import should_hook_act
from hook_emission import record_emission

CAPTURE_INSTRUCTION = (
    "In the summary, add a section headed 'Unstored facts and pointers'. List each "
    "fact (something learned that changes what the next agent does) and each pointer "
    "(where a durable artifact lives) from this conversation that was not stored with "
    "`bottega agent context set`, one per line with the task key it belongs to, or write "
    "'none'. Do not list rulings or positions."
)


def main():
    try:
        payload = json.load(sys.stdin)
        if not should_hook_act(payload):
            return 0
        if orch_worker_session():
            return 0
        record_emission(payload, "additionalContext", CAPTURE_INSTRUCTION)
        print(CAPTURE_INSTRUCTION)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
