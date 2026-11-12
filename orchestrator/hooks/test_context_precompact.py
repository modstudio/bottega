#!/usr/bin/env python3
"""Gate the non-blocking PreCompact context hook without calling the command binary."""

import importlib.util
import io
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

spec = importlib.util.spec_from_file_location(
    "context_precompact", Path(__file__).with_name("context-precompact.py")
)
context_precompact = importlib.util.module_from_spec(spec)
spec.loader.exec_module(context_precompact)


class ContextPreCompact(unittest.TestCase):
    def invoke(self, result):
        stdin = io.StringIO('{"session_id":"session-1","cwd":"/tmp"}')
        stdout = io.StringIO()
        with mock.patch.object(sys, "stdin", stdin), mock.patch.object(
            sys, "stdout", stdout
        ), mock.patch.object(
            context_precompact.subprocess, "run", return_value=result
        ) as run:
            code = context_precompact.main()
        return code, stdout.getvalue(), run

    def test_verb_failure_prints_notice_and_exits_zero(self):
        code, output, _ = self.invoke(SimpleNamespace(returncode=1, stdout="", stderr="store unavailable\n"))
        self.assertEqual(code, 0)
        self.assertEqual(
            output,
            "context: worked list not recorded: exit 1: store unavailable\n",
        )

    def test_success_prints_the_worked_list(self):
        code, output, run = self.invoke(
            SimpleNamespace(returncode=0, stdout="Worked: DEV-2268, DEV-1844\n", stderr="")
        )
        self.assertEqual(code, 0)
        self.assertEqual(output, "Worked: DEV-2268, DEV-1844\n")
        self.assertEqual(run.call_args.kwargs["env"]["CLAUDE_CODE_SESSION_ID"], "session-1")

    def test_timeout_prints_notice_and_exits_zero(self):
        with mock.patch.object(
            context_precompact.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired(["command"], 5),
        ):
            self.assertEqual(
                context_precompact.record_worked({"session_id": "session-1", "cwd": "/tmp"}),
                "context: worked list not recorded: timeout",
            )


if __name__ == "__main__":
    unittest.main()
