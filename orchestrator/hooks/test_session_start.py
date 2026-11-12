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
    def run_hook(self, payload, result=None):
        stdout = io.StringIO()
        patches = [
            mock.patch.object(sys, "stdin", io.StringIO(json.dumps(payload))),
            mock.patch.object(sys, "stdout", stdout),
        ]
        if result is not None:
            patches.append(mock.patch.object(session_start.subprocess, "run", return_value=result))
        with patches[0], patches[1]:
            if len(patches) > 2:
                with patches[2]:
                    code = session_start.main()
            else:
                code = session_start.main()
        return code, json.loads(stdout.getvalue())

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


if __name__ == "__main__":
    unittest.main()
