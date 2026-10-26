import importlib.util
import io
import json
import os
import sqlite3
import tempfile
import time
import unittest
import uuid
from contextlib import redirect_stderr
from unittest.mock import patch


PATH = os.path.join(os.path.dirname(__file__), "block-agent.py")


class SpawnIdentityTest(unittest.TestCase):
    def load_hook(self, database):
        previous = os.environ.get("BOTTEGA_ORCHESTRATOR_DB")
        os.environ["BOTTEGA_ORCHESTRATOR_DB"] = database
        try:
            spec = importlib.util.spec_from_file_location("block_agent", PATH)
            block_agent = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(block_agent)
            return block_agent
        finally:
            if previous is None:
                os.environ.pop("BOTTEGA_ORCHESTRATOR_DB", None)
            else:
                os.environ["BOTTEGA_ORCHESTRATOR_DB"] = previous

    def test_logged_spawn_has_version_seven_record_id(self):
        with tempfile.TemporaryDirectory() as folder:
            database = os.path.join(folder, "orchestrator.db")
            connection = sqlite3.connect(database)
            connection.execute(
                """CREATE TABLE spawn (
                  record_id TEXT NOT NULL UNIQUE, at TEXT NOT NULL, session_id TEXT, cwd TEXT,
                  event TEXT, subagent_type TEXT, description TEXT, prompt_bytes INTEGER,
                  decision TEXT NOT NULL, why TEXT NOT NULL
                )"""
            )
            connection.close()
            block_agent = self.load_hook(database)
            block_agent.log("allowed", "test", {}, "PreToolUse", {})
            connection = sqlite3.connect(database)
            record_id = connection.execute("SELECT record_id FROM spawn").fetchone()[0]
            connection.close()
            parsed = uuid.UUID(record_id)
            self.assertEqual(parsed.version, 7)
            self.assertEqual(record_id, str(parsed))

    def test_fallback_uuid_has_version_variant_and_current_timestamp(self):
        with tempfile.TemporaryDirectory() as folder:
            block_agent = self.load_hook(os.path.join(folder, "orchestrator.db"))
            before_ms = int(time.time() * 1000)
            with patch.object(block_agent.uuid, "uuid7", None, create=True):
                minted = block_agent.mint_uuid7()
            after_ms = int(time.time() * 1000)

            self.assertEqual(minted.version, 7)
            self.assertEqual(minted.variant, uuid.RFC_4122)
            timestamp_ms = minted.int >> 80
            self.assertLessEqual(before_ms, timestamp_ms)
            self.assertLessEqual(timestamp_ms, after_ms)

    def test_uuid_failure_takes_the_fail_open_write_failure_path(self):
        with tempfile.TemporaryDirectory() as folder:
            database = os.path.join(folder, "orchestrator.db")
            sqlite3.connect(database).close()
            block_agent = self.load_hook(database)
            stderr = io.StringIO()
            with patch.object(
                block_agent.uuid,
                "uuid7",
                side_effect=RuntimeError("mint failed"),
                create=True,
            ):
                with redirect_stderr(stderr):
                    block_agent.log("allowed", "test", {}, "PreToolUse", {})

            self.assertEqual(
                stderr.getvalue().split(": ", 1)[1],
                "spawn not logged (RuntimeError: mint failed)\n",
            )
            with open(block_agent.FALLBACK_LOG) as fallback:
                row = fallback.read().splitlines()
            self.assertEqual(len(row), 1)
            self.assertTrue(row[0].startswith("\t"))
            self.assertIn("\tallowed\ttest", row[0])

    def test_machine_harness_setting_admits_native_agent_with_distinct_decision(self):
        with tempfile.TemporaryDirectory() as folder:
            block_agent = self.load_hook(os.path.join(folder, "orchestrator.db"))
            payload = {
                "hook_event_name": "PreToolUse",
                "tool_name": "Agent",
                "tool_input": {"description": "implement the change", "prompt": "work"},
            }
            with (
                patch("sys.stdin", io.StringIO(json.dumps(payload))),
                patch.object(block_agent, "harness_delegation", return_value=["delegation.implement"]),
                patch.object(block_agent, "log") as logged,
                patch("sys.stdout", new_callable=io.StringIO) as stdout,
            ):
                self.assertEqual(block_agent.main(), 0)

            self.assertEqual(stdout.getvalue(), "")
            self.assertEqual(logged.call_args.args[0:2], ("harness-delegation", "delegation.implement"))

    def test_machine_config_read_failure_keeps_the_existing_gate(self):
        with tempfile.TemporaryDirectory() as folder:
            block_agent = self.load_hook(os.path.join(folder, "orchestrator.db"))
            with patch.object(block_agent.subprocess, "run", side_effect=OSError("unavailable")):
                self.assertEqual(block_agent.harness_delegation(), [])


if __name__ == "__main__":
    unittest.main()
