#!/usr/bin/env python3
"""The SessionStart explore hook always passes the verb's result through without blocking."""

import importlib.util
import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
spec = importlib.util.spec_from_file_location(
    "session_start", Path(__file__).with_name("session-start.py")
)
session_start = importlib.util.module_from_spec(spec)
spec.loader.exec_module(session_start)


class SessionStartHook(unittest.TestCase):
    def run_hook(self, payload, result=None, environment=None):
        stdout = io.StringIO()
        controlled_environment = dict(os.environ)
        controlled_environment.pop("BOTTEGA_RUN_ID", None)
        controlled_environment.update(environment or {})
        patches = [
            mock.patch.object(sys, "stdin", io.StringIO(json.dumps(payload))),
            mock.patch.object(sys, "stdout", stdout),
            mock.patch.dict(os.environ, controlled_environment, clear=True),
        ]
        if result is not None:
            patches.append(mock.patch.object(session_start.subprocess, "run", return_value=result))
        with patches[0], patches[1], patches[2]:
            if len(patches) > 3:
                with patches[3]:
                    code = session_start.main()
            else:
                code = session_start.main()
        rendered = stdout.getvalue()
        return code, json.loads(rendered) if rendered else None

    def test_passes_cursor_line_as_session_context(self):
        result = session_start.subprocess.CompletedProcess([], 0, "cursor 7 explore\n", "")
        code, output = self.run_hook(
            {"cwd": "/tmp/project", "session_id": "session"}, result
        )
        self.assertEqual(code, 0)
        self.assertEqual(
            output["hookSpecificOutput"]["additionalContext"], "cursor 7 explore"
        )

    def test_missing_session_is_a_nonblocking_remedied_line(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            code, output = self.run_hook({"cwd": "/tmp/project"})
        self.assertEqual(code, 0)
        text = output["hookSpecificOutput"]["additionalContext"]
        self.assertIn("could not establish", text)
        self.assertIn("cleared by:", text)

    def test_empty_command_output_is_a_nonblocking_remedied_line(self):
        result = session_start.subprocess.CompletedProcess([], 1, "", "")
        code, output = self.run_hook(
            {"cwd": "/tmp/project", "session_id": "session"}, result
        )
        self.assertEqual(code, 0)
        text = output["hookSpecificOutput"]["additionalContext"]
        self.assertIn("command exited 1", text)
        self.assertIn("cleared by:", text)

    def test_delegated_run_exits_without_output(self):
        with mock.patch.dict(os.environ, {"BOTTEGA_RUN_ID": "run"}, clear=True):
            code, output = self.run_hook(
                {"cwd": "/tmp/project", "session_id": "session"},
                environment={"BOTTEGA_RUN_ID": "run"},
            )
        self.assertEqual(code, 0)
        self.assertIsNone(output)


if __name__ == "__main__":
    unittest.main()
