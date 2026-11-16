import contextlib
import io
import os
import subprocess
import tempfile
import unittest
from unittest import mock

from hook_emission import record_emission, text_hash, text_stats


class HookEmissionTest(unittest.TestCase):
    def test_normalizes_time_and_run_number(self):
        self.assertEqual(text_hash("run 12 at 2026-11-15T12:00:00Z"), text_hash("run 99 at 2026-11-15T13:01:02Z"))
        self.assertNotEqual(text_hash("allowed"), text_hash("denied"))

    def test_failed_launch_changes_no_stdout_and_writes_one_stderr_line(self):
        def fail(*_args, **_kwargs):
            raise OSError("no launch")
        stdout, stderr = io.StringIO(), io.StringIO()
        with tempfile.TemporaryDirectory() as state, mock.patch.dict(
            os.environ, {"BOTTEGA_STATE_HOME": state}, clear=False
        ), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            record_emission(
                {"session_id":"s", "hook_event_name":"Stop"},
                "systemMessage", "same", launch=fail, hook="stop-summary",
            )
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue().count("\n"), 1)

    def test_detached_launch_sends_child_stderr_to_state_log(self):
        launched = {}

        def capture(*args, **kwargs):
            launched.update(kwargs)

        with tempfile.TemporaryDirectory() as state, mock.patch.dict(
            os.environ, {"BOTTEGA_STATE_HOME": state}, clear=False
        ):
            record_emission(
                {"session_id": "s", "hook_event_name": "Stop"},
                "systemMessage", "same", launch=capture, hook="stop-summary",
            )
            self.assertIsNot(launched["stderr"], subprocess.DEVNULL)
            self.assertTrue(hasattr(launched["stderr"], "write"))
            self.assertTrue(
                os.path.isfile(os.path.join(state, "orchestrator", "hook-emission.log"))
            )

    def test_invalid_kind_writes_one_stderr_line_and_does_not_launch(self):
        launch = mock.Mock()
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            record_emission(
                {"session_id": "s", "hook_event_name": "Stop"},
                "unknown", "same", launch=launch, hook="stop-summary",
            )
        launch.assert_not_called()
        self.assertEqual(stderr.getvalue(), "stop-summary: invalid hook emission kind: unknown\n")

    def test_text_stats_counts_utf8_bytes_lines_and_characters(self):
        self.assertEqual(text_stats("é\nnext"), (7, 2, 6))


if __name__ == "__main__":
    unittest.main()
