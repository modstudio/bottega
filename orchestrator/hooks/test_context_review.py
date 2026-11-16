#!/usr/bin/env python3
"""The context-review hook gates the CLI call and always fails silent."""

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
    "context_review", Path(__file__).with_name("context-review.py")
)
context_review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(context_review)


class ContextReviewHook(unittest.TestCase):
    def run_hook(self, environment=None):
        stdout = io.StringIO()
        env = {
            "CONTEXT_REVIEW_HOOK_TIMEOUT_SECONDS": "5",
            "BOTTEGA_GLOBAL_USE": "on",
        }
        env.update(environment or {})
        with mock.patch.object(sys, "stdin", io.StringIO(json.dumps({
            "session_id": "session", "hook_event_name": "PostToolUse"
        }))), mock.patch.object(sys, "stdout", stdout), mock.patch.dict(
            os.environ, env, clear=True
        ):
            code = context_review.main()
        return code, stdout.getvalue()

    def test_fast_path_does_not_call_the_verb(self):
        with mock.patch.object(context_review, "read_marker", return_value={"next_due_at": 9999999999}), mock.patch.object(
            context_review.subprocess, "run"
        ) as run:
            code, output = self.run_hook()
        self.assertEqual(code, 0)
        self.assertEqual(output, "")
        run.assert_not_called()

    def test_worker_session_does_not_call_the_verb(self):
        with mock.patch.object(context_review.subprocess, "run") as run:
            code, output = self.run_hook({"BOTTEGA_RUN_ID": "run"})
        self.assertEqual(code, 0)
        self.assertEqual(output, "")
        run.assert_not_called()

    def test_due_review_is_injected_and_marker_is_advanced(self):
        result = subprocess_result(json.dumps({
            "due": True,
            "next_due_at": "2026-11-16T13:00:00.000Z",
            "review": "Context review",
        }))
        with mock.patch.object(context_review, "read_marker", return_value={}), mock.patch.object(
            context_review, "write_marker", return_value=True
        ) as write, mock.patch.object(
            context_review.subprocess, "run", return_value=result
        ), mock.patch.object(context_review, "record_emission"):
            code, output = self.run_hook()
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output)["hookSpecificOutput"]["additionalContext"], "Context review")
        write.assert_called_once()


def subprocess_result(stdout):
    return context_review.subprocess.CompletedProcess([], 0, stdout, "")


if __name__ == "__main__":
    unittest.main()
