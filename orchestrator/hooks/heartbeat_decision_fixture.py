"""The decision module both heartbeat test files load, and the path it came from.

`heartbeat-decision.py` carries a hyphen, so it is loaded from its path rather
than imported by name, and every fixture that copies the hook files into a
throwaway checkout finds them by that same path. Both
`test_heartbeat_decision.py` and `process_heartbeat_shell.py` need the load, so
it lives here instead of in either of them.
"""

import importlib.util
import sys
from pathlib import Path

PATH = Path(__file__).with_name("heartbeat-decision.py")
sys.path.insert(0, str(PATH.parent))

SPEC = importlib.util.spec_from_file_location("heartbeat_decision", PATH)
heartbeat_decision = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(heartbeat_decision)
