import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


os.environ.setdefault("BOTTEGA_ORCHESTRATOR_DB", os.path.join(tempfile.gettempdir(), "heartbeat-guard-test.db"))
SPEC = importlib.util.spec_from_file_location(
    "heartbeat_guard", Path(__file__).with_name("heartbeat-guard.py")
)
heartbeat_guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(heartbeat_guard)


class Result:
    def __init__(self, data):
        self.stdout = json.dumps({"schema_version": 2, "kind": "run", "data": data}) + "\n"


class HeartbeatGuardRunIdentityTest(unittest.TestCase):
    def test_requests_alone_print_nothing(self):
        output = io.StringIO()
        with (
            patch.object(heartbeat_guard, "live_runs", return_value=[]),
            patch.object(heartbeat_guard, "live_landing_ids", return_value=[]),
            patch.object(sys, "stdin", io.StringIO('{"session_id":"session"}')),
            redirect_stdout(output),
        ):
            self.assertEqual(heartbeat_guard.main(), 0)
        self.assertEqual(output.getvalue(), "")

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
            self.assertEqual(heartbeat_guard.live_runs("session"), [(run_id, "running")])

    def test_retired_integer_identity_fails_open(self):
        with patch.object(
            heartbeat_guard.subprocess,
            "run",
            return_value=Result({"id": 42, "session_id": "session", "status": "running"}),
        ):
            self.assertIsNone(heartbeat_guard.live_runs("session"))

    def test_running_and_asking_runs_print_counted_line_without_titles(self):
        output = io.StringIO()
        rows = [
            ("00000000-0000-4000-8000-000000000001", "running"),
            ("00000000-0000-4000-8000-000000000002", "asking"),
        ]
        with (
            patch.object(heartbeat_guard, "live_runs", return_value=rows),
            patch.object(heartbeat_guard, "live_landing_ids", return_value=[]),
            patch.object(heartbeat_guard, "heartbeat_armed", return_value=False),
            patch.object(heartbeat_guard, "first_observation", return_value=True),
            patch.object(sys, "stdin", io.StringIO('{"session_id":"session"}')),
            redirect_stdout(output),
        ):
            self.assertEqual(heartbeat_guard.main(), 0)
        message = json.loads(output.getvalue())
        self.assertEqual(message["decision"], "block")
        self.assertEqual(
            message["reason"],
            f"Heartbeat off: 1 run · 0 landings · 1 worker question. Arm: "
            f"{heartbeat_guard.heartbeat_path()} session",
        )
        self.assertNotIn("Need a ruling", message["reason"])

    def test_unreadable_landing_store_prints_unknown(self):
        output = io.StringIO()
        with (
            patch.object(heartbeat_guard, "live_runs", return_value=[]),
            patch.object(heartbeat_guard, "live_landing_ids", return_value=None),
            patch.object(heartbeat_guard, "heartbeat_armed", return_value=False),
            patch.object(heartbeat_guard, "first_observation", return_value=False),
            patch.object(sys, "stdin", io.StringIO('{"session_id":"session"}')),
            redirect_stdout(output),
        ):
            self.assertEqual(heartbeat_guard.main(), 0)
        message = json.loads(output.getvalue())
        self.assertEqual(
            message["systemMessage"],
            f"Heartbeat off: 0 runs · landings unknown · 0 worker questions. Arm: "
            f"{heartbeat_guard.heartbeat_path()} session",
        )


if __name__ == "__main__":
    unittest.main()
