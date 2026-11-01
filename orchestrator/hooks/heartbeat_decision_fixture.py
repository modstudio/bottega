"""The decision module both heartbeat test files load, and the path it came from.

`heartbeat-decision.py` carries a hyphen, so it is loaded from its path rather
than imported by name, and every fixture that copies the hook files into a
throwaway checkout finds them by that same path. Both
`test_heartbeat_decision.py` and `process_heartbeat_shell.py` need the load, so
it lives here instead of in either of them.
"""

import importlib.util
import shutil
import sys
from pathlib import Path

PATH = Path(__file__).with_name("heartbeat-decision.py")
HEARTBEAT_SOURCE_NAMES = (
    "heartbeat-decision.py",
    "secret_shaped.py",
    "heartbeat-board-observation.py",
    "heartbeat-run-observation.py",
    "inbox_question_decision.py",
    "notice_transport.py",
    "orch-heartbeat.sh",
)


def stage_heartbeat_sources(hooks):
    """Copy the complete heartbeat runtime into a throwaway checkout."""
    for name in HEARTBEAT_SOURCE_NAMES:
        shutil.copy2(PATH.with_name(name), hooks / name)
    shared = hooks.parents[1] / "shared"
    shared.mkdir(exist_ok=True)
    shutil.copy2(
        PATH.parents[2] / "shared" / "secret-shaped-rules.json",
        shared / "secret-shaped-rules.json",
    )


sys.path.insert(0, str(PATH.parent))

SPEC = importlib.util.spec_from_file_location("heartbeat_decision", PATH)
heartbeat_decision = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(heartbeat_decision)
