import contextlib
import io
import unittest

from hook_emission import record_emission, text_hash


class HookEmissionTest(unittest.TestCase):
    def test_normalizes_time_and_run_number(self):
        self.assertEqual(text_hash("run 12 at 2026-11-15T12:00:00Z"), text_hash("run 99 at 2026-11-15T13:01:02Z"))
        self.assertNotEqual(text_hash("allowed"), text_hash("denied"))

    def test_failed_launch_changes_no_stdout_and_writes_one_stderr_line(self):
        def fail(*_args, **_kwargs):
            raise OSError("no launch")
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            record_emission({"session_id":"s", "hook_event_name":"Stop"}, "stop-summary", "systemMessage", "same", launch=fail)
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue().count("\n"), 1)


if __name__ == "__main__":
    unittest.main()
