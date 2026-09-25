#!/usr/bin/env python3
"""Gate the SessionStart additionalContext budget without calling orch."""
import importlib.util
import sys
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "session_brief", Path(__file__).with_name("session-brief.py")
)
session_brief = importlib.util.module_from_spec(spec)
spec.loader.exec_module(session_brief)


class AssembleAdditionalContext(unittest.TestCase):
    def test_budget_constant_stays_under_the_harness_cap(self):
        self.assertEqual(session_brief.HOOK_CONTEXT_MAX_CHARS, 9000)

    def test_keeps_every_section_when_under_budget(self):
        text = session_brief.assemble_additional_context(
            resume="resume offer",
            inbox="inbox detail",
            issues="filed issues",
            autonomy="autonomy slice",
            extra="heartbeat",
            budget=200,
        )
        self.assertEqual(
            text,
            "resume offer\ninbox detail\nfiled issues\nautonomy slice\nheartbeat",
        )
        self.assertNotIn("Dropped", text)

    def test_drops_filed_issues_first(self):
        text = session_brief.assemble_additional_context(
            resume="resume offer",
            inbox="inbox detail",
            issues="x" * 80,
            autonomy="autonomy slice",
            extra="",
            budget=100,
        )
        self.assertIn("resume offer", text)
        self.assertIn("autonomy slice", text)
        self.assertIn("inbox detail", text)
        self.assertNotIn("x" * 80, text)
        self.assertIn("Dropped filed issues (orch fix-defect --waiting).", text)

    def test_drops_inbox_after_issues_and_never_drops_autonomy_or_resume(self):
        text = session_brief.assemble_additional_context(
            resume="resume offer",
            inbox="y" * 80,
            issues="x" * 80,
            autonomy="autonomy slice",
            extra="heartbeat",
            budget=80,
        )
        self.assertIn("resume offer", text)
        self.assertIn("autonomy slice", text)
        self.assertIn("heartbeat", text)
        self.assertNotIn("x" * 80, text)
        self.assertNotIn("y" * 80, text)
        self.assertIn(
            "Dropped filed issues (orch fix-defect --waiting) and inbox detail (orch inbox).",
            text,
        )


if __name__ == "__main__":
    result = unittest.TextTestRunner(stream=sys.stdout, verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    )
    raise SystemExit(0 if result.wasSuccessful() else 1)
