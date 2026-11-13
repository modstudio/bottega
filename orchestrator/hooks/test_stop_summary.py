#!/usr/bin/env python3
import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
spec = importlib.util.spec_from_file_location(
    "stop_summary", Path(__file__).with_name("stop-summary.py")
)
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)
PRODUCT = "bot" + "tega"


class Result:
    def __init__(self, value, returncode=0):
        self.stdout = json.dumps(value)
        self.stderr = ""
        self.returncode = returncode


class StopSummaryHookTest(unittest.TestCase):
    def test_blocks_once_then_summarizes_the_unchanged_set(self):
        payload = {"session_id": "session", "cwd": "/tmp"}
        commands = []

        def run(command, **_options):
            commands.append(command)
            if "--block-key" in command:
                return Result({"lines": ["Nothing waiting on you", f"1 item owed → {PRODUCT} score pending"], "block": False, "reason": f"Nothing waiting on you\nrun 12 unscored → {PRODUCT} score 12", "blockKey": "decision-key"})
            return Result({"lines": ["Nothing waiting on you", f"run 12 unscored → {PRODUCT} score 12"], "block": True, "reason": f"Nothing waiting on you\nrun 12 unscored → {PRODUCT} score 12", "blockKey": "decision-key"})

        with tempfile.TemporaryDirectory() as state, mock.patch.dict(
            os.environ, {"BOTTEGA_BOARD_HOOK_STATE": state}, clear=False
        ), mock.patch.object(hook.subprocess, "run", side_effect=run):
            first = hook.summary(payload, ["session", "environment-session"], time.monotonic() + 5)
            second = hook.summary(payload, ["session", "environment-session"], time.monotonic() + 5)
            stored_key = hook.read_marker(
                hook.marker_path("stop-summary", "session")
            )["blockKey"]
        self.assertEqual(first["decision"], "block")
        self.assertEqual(stored_key, "decision-key")
        self.assertEqual(second["systemMessage"].splitlines()[-1], f"1 item owed → {PRODUCT} score pending")
        self.assertEqual(commands[0][commands[0].index("--session") + 1], "session")
        self.assertNotIn("--block-key", commands[0])
        self.assertEqual(commands[1][commands[1].index("--block-key") + 1], "decision-key")

    def test_marker_write_failure_allows_stop_and_reports_it(self):
        report = {
            "lines": ["Nothing waiting on you", f"run 12 unscored → {PRODUCT} score 12"],
            "block": True,
            "reason": f"Nothing waiting on you\nrun 12 unscored → {PRODUCT} score 12",
            "blockKey": "decision-key",
        }
        stderr = io.StringIO()
        with mock.patch.object(
            hook.subprocess, "run", return_value=Result(report)
        ), mock.patch.object(hook, "write_marker", return_value=False), contextlib.redirect_stderr(
            stderr
        ):
            result = hook.summary(
                {"session_id": "session", "cwd": "/tmp"},
                ["session"],
                time.monotonic() + 5,
            )
        self.assertNotIn("decision", result)
        self.assertIn("run 12 unscored", result["systemMessage"])
        self.assertIn("block-once marker could not be recorded", stderr.getvalue())

    def test_cleanup_still_closes_each_terminal_worktree_root(self):
        connection = mock.Mock()
        connection.execute.return_value.fetchall.return_value = [(12,), (14,)]
        with mock.patch.dict(os.environ, {"BOTTEGA_ORCHESTRATOR_DB": "/tmp/store"}), mock.patch.object(
            hook.os.path, "exists", return_value=True
        ), mock.patch.object(hook.sqlite3, "connect", return_value=connection), mock.patch.object(
            hook.subprocess, "run", return_value=Result({"outcome": "released"})
        ) as run:
            hook.cleanup(["session"], time.monotonic() + 5)
        commands = [call.args[0] for call in run.call_args_list]
        self.assertTrue(any(command[1:4] == ["run", "close-out", "12"] for command in commands))
        self.assertTrue(any(command[1:4] == ["run", "close-out", "14"] for command in commands))

    def test_verb_failure_allows_stop_and_says_status_is_unavailable(self):
        output = io.StringIO()
        with mock.patch.object(hook, "should_hook_act", return_value=True), mock.patch.object(
            hook, "cleanup"
        ), mock.patch.object(hook, "summary", side_effect=RuntimeError("failed")), mock.patch.object(
            hook.sys, "stdin", io.StringIO(json.dumps({"session_id": "session", "cwd": "/tmp"}))
        ), contextlib.redirect_stdout(output):
            self.assertEqual(hook.main(), 0)
        message = json.loads(output.getvalue())
        self.assertNotIn("decision", message)
        self.assertIn("Session status unavailable; Stop proceeded", message["systemMessage"])


if __name__ == "__main__":
    unittest.main()
