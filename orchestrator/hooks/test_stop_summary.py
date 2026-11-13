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


class Result:
    def __init__(self, value, returncode=0):
        self.stdout = json.dumps(value)
        self.stderr = ""
        self.returncode = returncode


class StopSummaryHookTest(unittest.TestCase):
    def test_blocks_once_then_summarizes_the_unchanged_set(self):
        payload = {"session_id": "session", "cwd": "/tmp"}

        def run(_command, **options):
            if options["env"].get("BOTTEGA_STOP_SUMMARY_BLOCK_KEY"):
                return Result({"lines": ["Nothing waiting on you", "1 item owed → bottega score pending"], "block": False, "reason": "Nothing waiting on you\nrun 12 unscored → bottega score 12"})
            return Result({"lines": ["Nothing waiting on you", "run 12 unscored → bottega score 12"], "block": True, "reason": "Nothing waiting on you\nrun 12 unscored → bottega score 12"})

        with tempfile.TemporaryDirectory() as state, mock.patch.dict(
            os.environ, {"BOTTEGA_BOARD_HOOK_STATE": state}, clear=False
        ), mock.patch.object(hook, "actionable_notes", return_value=[]), mock.patch.object(
            hook.subprocess, "run", side_effect=run
        ):
            first = hook.summary(payload, ["session"], time.monotonic() + 5)
            second = hook.summary(payload, ["session"], time.monotonic() + 5)
        self.assertEqual(first["decision"], "block")
        self.assertEqual(second["systemMessage"].splitlines()[-1], "1 item owed → bottega score pending")

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
