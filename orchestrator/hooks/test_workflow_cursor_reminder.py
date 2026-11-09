#!/usr/bin/env python3
"""Gate stale-context Stop reminders without calling the command binary."""
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
spec = importlib.util.spec_from_file_location(
    "workflow_cursor_reminder", Path(__file__).with_name("workflow-cursor-reminder.py")
)
reminder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reminder)


class StaleContextReminder(unittest.TestCase):
    def test_same_event_set_prints_once(self):
        rows = [{"holder": "DEV-2225", "workedAt": "2026-11-08T12:00:00Z", "revisedAt": None}]
        with tempfile.TemporaryDirectory() as state, mock.patch.dict(
            os.environ, {"BOTTEGA_BOARD_HOOK_STATE": state}
        ):
            self.assertEqual(reminder.unseen_stale_rows("session", rows), rows)
            self.assertEqual(reminder.unseen_stale_rows("session", rows), [])

    def test_stop_reminder_never_blocks(self):
        rows = [{"holder": "DEV-2225", "workedAt": "2026-11-08T12:00:00Z", "revisedAt": None}]
        emitted = []
        with mock.patch.object(reminder, "query_cursors", return_value=([], None)), mock.patch.object(
            reminder, "query_stale", return_value=rows
        ), mock.patch.object(reminder, "unseen_stale_rows", return_value=rows), mock.patch.object(
            reminder, "emit", side_effect=emitted.append
        ):
            reminder.handle_stop({"session_id": "session", "cwd": "/tmp"})
        self.assertEqual(len(emitted), 1)
        self.assertNotIn("decision", emitted[0])
        self.assertIn("DEV-2225", json.dumps(emitted[0]))


if __name__ == "__main__":
    unittest.main()
