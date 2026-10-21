import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


os.environ.setdefault("ORCH_DB", os.path.join(tempfile.gettempdir(), "heartbeat-guard-test.db"))
SPEC = importlib.util.spec_from_file_location(
    "heartbeat_guard", Path(__file__).with_name("heartbeat-guard.py")
)
heartbeat_guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(heartbeat_guard)


class Result:
    def __init__(self, data):
        self.stdout = json.dumps({"schema_version": 2, "kind": "run", "data": data}) + "\n"


class HeartbeatGuardRunIdentityTest(unittest.TestCase):
    def test_current_run_listing_uuid_is_enforced(self):
        run_id = "00000000-0000-4000-8000-000000000042"
        with patch.object(
            heartbeat_guard.subprocess,
            "run",
            return_value=Result(
                {
                    "record_id": run_id,
                    "number": 42,
                    "session_id": "session",
                    "status": "running",
                }
            ),
        ):
            self.assertEqual(heartbeat_guard.live_run_ids("session"), [run_id])

    def test_retired_integer_identity_fails_open(self):
        with patch.object(
            heartbeat_guard.subprocess,
            "run",
            return_value=Result({"id": 42, "session_id": "session", "status": "running"}),
        ):
            self.assertIsNone(heartbeat_guard.live_run_ids("session"))


if __name__ == "__main__":
    unittest.main()
