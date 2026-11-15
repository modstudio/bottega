#!/usr/bin/env python3
"""Exercise the PreCompact hook in process."""
import contextlib
import importlib.util
import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
spec = importlib.util.spec_from_file_location(
    "context_precompact", Path(__file__).with_name("context-precompact.py")
)
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


class ContextPrecompactHook(unittest.TestCase):
    def invoke(self, scope_decision=True):
        output = io.StringIO()
        with mock.patch.object(hook.sys, "stdin", io.StringIO(json.dumps({"cwd": "/tmp"}))):
            with mock.patch.object(
                hook, "should_hook_act", return_value=scope_decision
            ), contextlib.redirect_stdout(output):
                code = hook.main()
        return code, output.getvalue()

    def test_prints_the_capture_instruction_and_allows_compaction(self):
        code, output = self.invoke()
        self.assertEqual(code, 0)
        self.assertEqual(output, hook.CAPTURE_INSTRUCTION + "\n")
        self.assertEqual(output.count("\n"), 1)

    def test_exception_prints_nothing_and_allows_compaction(self):
        output = io.StringIO()
        with mock.patch.object(
            hook.sys, "stdin", io.StringIO(json.dumps({"cwd": "/tmp"}))
        ):
            with mock.patch.object(
                hook, "should_hook_act", side_effect=RuntimeError("unavailable")
            ), contextlib.redirect_stdout(output):
                code = hook.main()
        self.assertEqual(code, 0)
        self.assertEqual(output.getvalue(), "")

    def test_out_of_scope_prints_nothing_and_allows_compaction(self):
        code, output = self.invoke(scope_decision=False)
        self.assertEqual(code, 0)
        self.assertEqual(output, "")


if __name__ == "__main__":
    unittest.main()
