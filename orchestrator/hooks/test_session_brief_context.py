#!/usr/bin/env python3
"""Gate the SessionStart additionalContext budget without calling orch."""
import importlib.util
import io
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

spec = importlib.util.spec_from_file_location(
    "session_brief", Path(__file__).with_name("session-brief.py")
)
session_brief = importlib.util.module_from_spec(spec)
spec.loader.exec_module(session_brief)


class AssembleAdditionalContext(unittest.TestCase):
    def assemble(self, budget, **sections):
        text = session_brief.assemble_additional_context(budget=budget, **sections)
        self.assertLessEqual(len(text), budget)
        return text

    def test_budget_constant_stays_under_the_harness_cap(self):
        self.assertEqual(session_brief.HOOK_CONTEXT_MAX_CHARS, 9000)

    def test_keeps_every_section_when_under_budget(self):
        text = self.assemble(
            200,
            resume_offer="resume offer",
            resume_table="resume table",
            inbox="inbox detail",
            issues="filed issues",
            autonomy="autonomy slice",
            extra="heartbeat",
        )
        self.assertEqual(
            text,
            "autonomy slice\nresume offer\nresume table\ninbox detail\nfiled issues\nheartbeat",
        )
        self.assertNotIn("Dropped", text)

    def test_drops_filed_issues_first(self):
        text = self.assemble(
            100,
            resume_offer="resume offer",
            resume_table="",
            inbox="inbox detail",
            issues="x" * 80,
            autonomy="autonomy slice",
            extra="",
        )
        self.assertIn("autonomy slice", text)
        self.assertIn("resume offer", text)
        self.assertIn("inbox detail", text)
        self.assertNotIn("x" * 80, text)
        self.assertIn("Dropped filed issues (orch fix-defect --waiting).", text)
        self.assertNotIn("inbox detail (orch inbox)", text)

    def test_drops_inbox_after_issues_and_never_drops_autonomy_or_resume_offer(self):
        text = self.assemble(
            80,
            resume_offer="resume offer",
            resume_table="",
            inbox="y" * 80,
            issues="x" * 80,
            autonomy="autonomy slice",
            extra="heartbeat",
        )
        self.assertIn("autonomy slice", text)
        self.assertIn("resume offer", text)
        self.assertNotIn("x" * 80, text)
        self.assertNotIn("y" * 80, text)
        self.assertNotIn("\nheartbeat\n", text)
        self.assertFalse(text.endswith("heartbeat"))
        self.assertIn("Dropped", text)
        self.assertTrue(text.startswith("autonomy slice\nresume offer\n"))

    def test_drops_extra_before_resume_table(self):
        extra = "z" * 200
        text = self.assemble(
            120,
            resume_offer="resume offer",
            resume_table="resume table row",
            inbox="",
            issues="",
            autonomy="autonomy slice",
            extra=extra,
        )
        self.assertIn("autonomy slice", text)
        self.assertIn("resume offer", text)
        self.assertIn("resume table row", text)
        self.assertNotIn(extra, text)
        self.assertEqual(
            text,
            "autonomy slice\nresume offer\nresume table row\n"
            "Dropped heartbeat and monitor extra (orch monitor).",
        )

    def test_drops_resume_table_after_extra(self):
        table = "t" * 200
        text = self.assemble(
            200,
            resume_offer="resume offer",
            resume_table=table,
            inbox="",
            issues="",
            autonomy="autonomy slice",
            extra="arm-heartbeat",
        )
        self.assertIn("autonomy slice", text)
        self.assertIn("resume offer", text)
        self.assertNotIn(table, text)
        self.assertNotIn("arm-heartbeat", text)
        self.assertEqual(
            text,
            "autonomy slice\nresume offer\n"
            "Dropped heartbeat and monitor extra (orch monitor) and "
            "resume table (orch doc resumes).",
        )

    def test_empty_droppables_add_no_drop_note(self):
        text = self.assemble(
            80,
            resume_offer="o" * 60,
            resume_table="",
            inbox="",
            issues="",
            autonomy="a" * 60,
            extra="",
        )
        self.assertNotIn("Dropped", text)
        self.assertTrue(text.startswith("a" * 60))
        self.assertTrue(text.endswith(session_brief.HOOK_CONTEXT_TRUNCATION_MARKER))

    def test_autonomy_slice_keeps_the_release_line(self):
        text = "plan: review (project)\nrelease: promote (land to main, then promote to production) (user)"
        rendered, notice = session_brief._autonomy_slice(
            SimpleNamespace(returncode=0, stdout=json.dumps({"registered": True, "text": text}))
        )
        self.assertEqual(rendered, text)
        self.assertIsNone(notice)

    def test_truncates_drop_note_when_protected_plus_note_exceed_budget(self):
        text = self.assemble(
            80,
            resume_offer="resume offer",
            resume_table="",
            inbox="y" * 80,
            issues="x" * 80,
            autonomy="autonomy slice",
            extra="",
        )
        self.assertTrue(text.startswith("autonomy slice\nresume offer\nDropped "))
        self.assertTrue(text.endswith(session_brief.HOOK_CONTEXT_TRUNCATION_MARKER))
        self.assertNotIn("x" * 80, text)
        self.assertNotIn("y" * 80, text)


class WorkerSessionSkip(unittest.TestCase):
    def test_orch_run_id_marks_a_worker_session(self):
        self.assertTrue(session_brief.orch_worker_session({"ORCH_RUN_ID": "12"}))
        self.assertFalse(session_brief.orch_worker_session({}))
        self.assertFalse(session_brief.orch_worker_session({"ORCH_RUN_ID": ""}))

    def test_main_emits_no_context_when_orch_run_id_is_set(self):
        stdin = io.StringIO(json.dumps({"cwd": "/tmp", "session_id": "s"}))
        stdout = io.StringIO()
        with mock.patch.dict(session_brief.os.environ, {"ORCH_RUN_ID": "12"}):
            with mock.patch.object(session_brief.sys, "stdin", stdin):
                with mock.patch.object(session_brief.sys, "stdout", stdout):
                    code = session_brief.main()
        self.assertEqual(code, 0)
        self.assertEqual(stdout.getvalue(), "")


if __name__ == "__main__":
    result = unittest.TextTestRunner(stream=sys.stdout, verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    )
    raise SystemExit(0 if result.wasSuccessful() else 1)
