#!/usr/bin/env python3
"""Gate the SessionStart additionalContext budget without calling orch."""
import importlib.util
import io
import json
import sys
import tempfile
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


class SettingsApplyNotice(unittest.TestCase):
    def completed(self, returncode=0, stdout="", stderr=""):
        return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)

    def test_changed_settings_announce_next_session(self):
        notice = session_brief._settings_apply_notice(
            self.completed(stdout="settings /tmp/settings.json: applied; backup /tmp/backup\n")
        )
        self.assertEqual(notice, "settings applied; they take effect in the next session")

    def test_current_settings_add_no_notice(self):
        notice = session_brief._settings_apply_notice(
            self.completed(stdout="settings /tmp/settings.json: already current\n")
        )
        self.assertIsNone(notice)

    def test_refusals_are_one_notice_line(self):
        notice = session_brief._settings_apply_notice(
            self.completed(
                returncode=1,
                stdout=(
                    "settings /tmp/settings.json: refused; move the key first\n"
                    "canon codex /tmp/codex: refused; not written: canon batch refused\n"
                ),
            )
        )
        self.assertEqual(notice.count("\n"), 0)
        self.assertIn("move the key first", notice)
        self.assertIn("canon batch refused", notice)

    def test_still_running_names_the_detached_log(self):
        self.assertEqual(
            session_brief._settings_apply_notice(None, "/state/orchestrator/settings-apply.log"),
            "settings apply still running; its result lands in "
            "/state/orchestrator/settings-apply.log",
        )

    def test_detached_completion_uses_logged_result(self):
        completed = self.completed(
            stdout="settings /tmp/settings.json: applied; backup /tmp/backup\n"
        )
        self.assertEqual(
            session_brief._settings_apply_notice(completed, "/state/settings-apply.log"),
            "settings applied; they take effect in the next session",
        )

    def test_settings_apply_starts_in_its_own_session_with_state_logging(self):
        process = SimpleNamespace()
        with tempfile.TemporaryDirectory() as state:
            with mock.patch.object(session_brief, "_state_root", return_value=state):
                with mock.patch.object(
                    session_brief.subprocess, "Popen", return_value=process
                ) as popen:
                    started, log_path, offset = session_brief._start_settings_apply("/bin/orch")
        self.assertIs(started, process)
        self.assertEqual(log_path, f"{state}/orchestrator/settings-apply.log")
        self.assertEqual(offset, 0)
        kwargs = popen.call_args.kwargs
        self.assertTrue(kwargs["start_new_session"])
        self.assertEqual(kwargs["stdin"], session_brief.subprocess.DEVNULL)
        self.assertEqual(kwargs["stderr"], session_brief.subprocess.STDOUT)

    def test_state_root_resolution_matches_the_shared_resolver(self):
        state_slug = "BOTTEGA_STATE_HOME".removesuffix("_STATE_HOME").lower()
        cases = (
            (
                {
                    "BOTTEGA_STATE_HOME": "/override/state",
                    "XDG_STATE_HOME": "/xdg/state",
                    "HOME": "/home/person",
                },
                "/override/state",
            ),
            (
                {"XDG_STATE_HOME": "/xdg/state", "HOME": "/home/person"},
                f"/xdg/state/{state_slug}",
            ),
            (
                {"XDG_STATE_HOME": "relative", "HOME": "/home/person"},
                f"/home/person/.local/state/{state_slug}",
            ),
            ({"HOME": "/home/person"}, f"/home/person/.local/state/{state_slug}"),
        )
        for environment, expected in cases:
            with self.subTest(environment=environment):
                self.assertEqual(session_brief._state_root(environment), expected)

    def test_relative_state_override_is_refused_instead_of_falling_back(self):
        environment = {
            "BOTTEGA_STATE_HOME": "relative/state",
            "XDG_STATE_HOME": "/xdg/state",
            "HOME": "/home/person",
        }
        with self.assertRaisesRegex(
            RuntimeError,
            "BOTTEGA_STATE_HOME must be an absolute state root; set it to an absolute path",
        ) as raised:
            session_brief._start_settings_apply("/bin/orch", environment)
        notice = session_brief._settings_apply_start_failure(raised.exception)
        self.assertEqual(
            notice,
            "Settings apply was not started: BOTTEGA_STATE_HOME must be an absolute "
            "state root; set it to an absolute path.",
        )

    def test_symlinked_settings_log_is_refused_without_changing_its_target(self):
        with tempfile.TemporaryDirectory() as state:
            log_directory = Path(state, "orchestrator")
            log_directory.mkdir()
            target = Path(state, "target.log")
            target.write_text("unchanged\n", encoding="utf-8")
            log_path = log_directory / "settings-apply.log"
            log_path.symlink_to(target)

            with self.assertRaises(OSError) as raised:
                session_brief._start_settings_apply(
                    "/bin/orch", {"BOTTEGA_STATE_HOME": state}
                )

            self.assertIn(str(log_path), str(raised.exception))
            self.assertIn(
                str(log_path),
                session_brief._settings_apply_start_failure(raised.exception),
            )
            self.assertEqual(target.read_text(encoding="utf-8"), "unchanged\n")

    def test_symlinked_settings_log_is_refused_when_reading_the_result(self):
        process = mock.Mock()
        process.poll.return_value = 0
        process.returncode = 0
        process.args = ["/bin/orch", "settings", "apply"]
        with tempfile.TemporaryDirectory() as state:
            target = Path(state, "target.log")
            target.write_text("settings target: applied; backup elsewhere\n", encoding="utf-8")
            log_path = Path(state, "settings-apply.log")
            log_path.symlink_to(target)

            with self.assertRaises(OSError) as raised:
                session_brief._wait_settings_apply(
                    process, float("inf"), str(log_path), 0
                )

            notice = session_brief._settings_apply_read_failure(
                str(log_path), raised.exception
            )
            self.assertIn(str(log_path), notice)
            self.assertEqual(
                target.read_text(encoding="utf-8"),
                "settings target: applied; backup elsewhere\n",
            )


if __name__ == "__main__":
    result = unittest.TextTestRunner(stream=sys.stdout, verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    )
    raise SystemExit(0 if result.wasSuccessful() else 1)
