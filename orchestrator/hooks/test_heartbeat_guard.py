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

    def test_open_request_never_blocks_and_names_the_thread(self):
        output = io.StringIO()
        with (
            patch.object(heartbeat_guard, "live_run_ids", return_value=[]),
            patch.object(heartbeat_guard, "live_landing_ids", return_value=[]),
            patch.object(
                heartbeat_guard,
                "open_request_threads",
                return_value=[{"id": "request-1", "label": "board:12 Need a ruling"}],
            ),
            patch.object(heartbeat_guard, "heartbeat_armed", return_value=False),
            patch.object(heartbeat_guard, "first_observation", return_value=True),
            patch.object(sys, "stdin", io.StringIO('{"session_id":"session"}')),
            redirect_stdout(output),
        ):
            self.assertEqual(heartbeat_guard.main(), 0)
        message = json.loads(output.getvalue())
        self.assertNotIn("decision", message)
        self.assertIn("1 open request: board:12 Need a ruling", message["systemMessage"])
        self.assertIn("orch-heartbeat.sh session", message["systemMessage"])

    def test_unreadable_board_policy_never_blocks_by_itself(self):
        output = io.StringIO()
        original_loader = heartbeat_guard.load_hook_module

        def load(name, filename):
            if filename == "heartbeat-decision.py":
                raise ImportError("decision unavailable")
            return original_loader(name, filename)

        with (
            patch.object(heartbeat_guard, "load_hook_module", side_effect=load),
            patch.object(heartbeat_guard, "live_run_ids", return_value=[]),
            patch.object(heartbeat_guard, "live_landing_ids", return_value=[]),
            patch.object(heartbeat_guard, "heartbeat_armed", return_value=False),
            patch.object(sys, "stdin", io.StringIO('{"session_id":"session"}')),
            redirect_stdout(output),
        ):
            self.assertEqual(heartbeat_guard.main(), 0)
        message = json.loads(output.getvalue())
        self.assertNotIn("decision", message)
        self.assertIn("board store unreadable", message["systemMessage"])
        self.assertIn("orch-heartbeat.sh session", message["systemMessage"])


if __name__ == "__main__":
    unittest.main()
