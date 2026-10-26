import importlib.util
import io
import json
import os
import sqlite3
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
    def test_real_board_projection_names_open_request_without_blocking(self):
        with tempfile.NamedTemporaryFile(suffix=".db") as store:
            connection = sqlite3.connect(store.name)
            connection.executescript(
                """
                CREATE TABLE board_message (
                  record_id TEXT PRIMARY KEY, number INTEGER, kind TEXT, purpose TEXT,
                  author_session TEXT, title TEXT, expires_at TEXT, withdrawn_at TEXT,
                  thread_root_record_id TEXT
                );
                CREATE TABLE board_receipt (
                  message_record_id TEXT, reader_session TEXT, delivered_at TEXT
                );
                CREATE TABLE hosted_board_message_cache (
                  id TEXT PRIMARY KEY, kind TEXT, thread_root_id TEXT, payload TEXT
                );
                CREATE TABLE hosted_board_receipt_cache (
                  message_id TEXT, reader_session TEXT, delivered_at TEXT
                );
                """
            )
            connection.execute(
                "INSERT INTO board_message VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    "request-1", 12, "notice", "request", "session",
                    "Need a ruling", "2099-01-15T09:00:00.000Z", None, None,
                ),
            )
            connection.commit()
            connection.close()

            output = io.StringIO()
            with (
                patch.object(heartbeat_guard, "DB", store.name),
                patch.object(heartbeat_guard, "live_run_ids", return_value=[]),
                patch.object(heartbeat_guard, "live_landing_ids", return_value=[]),
                patch.object(heartbeat_guard, "heartbeat_armed", return_value=False),
                patch.object(sys, "stdin", io.StringIO('{"session_id":"session"}')),
                redirect_stdout(output),
            ):
                self.assertEqual(heartbeat_guard.main(), 0)

        message = json.loads(output.getvalue())
        self.assertNotIn("decision", message)
        self.assertIn("board:12 Need a ruling", message["systemMessage"])

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
