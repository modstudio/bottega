#!/usr/bin/env python3
"""Gate the SessionStart additionalContext budget without calling bottega."""
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

    def test_filed_issue_sections_accept_current_uuid_run_ids(self):
        run_id = "00000000-0000-4000-8000-000000000042"
        self.assertTrue(
            session_brief._valid_filed_issue_loop_run(
                {"runId": run_id, "job": "issue-worker", "issueKey": "DEV-42"}
            )
        )
        self.assertTrue(
            session_brief._valid_blocked_issue_tree(
                {"runId": run_id, "path": "/tmp/tree", "why": "held"}
            )
        )
        self.assertFalse(
            session_brief._valid_filed_issue_loop_run(
                {"runId": 42, "job": "issue-worker", "issueKey": "DEV-42"}
            )
        )

    def board_completed(self, body="body", withheld=0):
        return SimpleNamespace(
            returncode=0,
            stdout=json.dumps({
                "notices": [{
                    "id": "7",
                    "text": (
                        "BOARD NOTICE 7 — INFORMATION ONLY\n"
                        "Origin: operator\nTitle: Important title\n"
                        "Acknowledgement: required\n" + body
                    ),
                    "oneLine": (
                        "Board message 7: Important title — from operator; "
                        "acknowledgement required."
                    ),
                    "ackRequired": True,
                }],
                "warning": None,
                "withheldOlderCount": withheld,
            }),
        )

    def test_session_start_keeps_full_board_delivery_when_it_fits(self):
        full, ids, titles, count, _withheld = session_brief._board_start_slice(
            self.board_completed()
        )
        context, mode, notice = session_brief.assemble_session_start_context(
            {"autonomy": "protected"}, full, titles, count, budget=500
        )
        self.assertEqual(mode, "full")
        self.assertIsNone(notice)
        self.assertIn("Acknowledgement: required", context)
        output = {"hookSpecificOutput": {"additionalContext": context}}
        self.assertEqual(session_brief._emitted_board_ids(output, full, ids), ["7"])

    def test_session_start_degrades_to_titles_without_stamping(self):
        full, ids, titles, count, _withheld = session_brief._board_start_slice(
            self.board_completed("body" * 100)
        )
        context, mode, notice = session_brief.assemble_session_start_context(
            {"autonomy": "protected"}, full, titles, count, budget=180
        )
        self.assertEqual(mode, "titles")
        self.assertIsNone(notice)
        self.assertIn(
            "Board message 7: Important title — from operator; acknowledgement required.",
            context,
        )
        self.assertNotIn("bodybody", context)
        output = {"hookSpecificOutput": {"additionalContext": context}}
        self.assertEqual(session_brief._emitted_board_ids(output, full, ids), [])

    def test_session_start_degrades_to_count_without_stamping(self):
        full, ids, titles, count, _withheld = session_brief._board_start_slice(
            self.board_completed("body" * 100)
        )
        context, mode, notice = session_brief.assemble_session_start_context(
            {"autonomy": "protected" * 8}, full, titles, count, budget=90
        )
        self.assertEqual(mode, "count")
        self.assertEqual(notice, "1 board message is waiting; bottega board read shows them.")
        self.assertNotIn("Important title", context)
        output = {"hookSpecificOutput": {"additionalContext": context}}
        self.assertEqual(session_brief._emitted_board_ids(output, full, ids), [])

    def test_new_session_sees_the_withheld_older_message_notice(self):
        _full, _ids, _titles, _count, withheld = session_brief._board_start_slice(
            self.board_completed(withheld=3)
        )
        self.assertEqual(
            session_brief._withheld_board_notice(withheld),
            "3 unexpired board messages posted before this session were withheld; "
            "bottega board read shows them.",
        )

    def test_board_start_slice_accepts_string_ids_for_post_emit_delivery(self):
        completed = SimpleNamespace(
            returncode=0,
            stdout=json.dumps([{"id": "7", "text": "notice one", "oneLine": "one"}, {"id": "8", "text": "notice two", "oneLine": "two"}]),
        )
        full, ids, titles, count, withheld = session_brief._board_start_slice(completed)
        self.assertEqual((full, ids, titles, count, withheld), ("notice one\n\nnotice two", ["7", "8"], "one\ntwo", 2, 0))

    def test_board_start_slice_keeps_accepting_integer_ids_for_post_emit_delivery(self):
        completed = SimpleNamespace(
            returncode=0,
            stdout=json.dumps([{"id": 7, "text": "notice one", "oneLine": "one"}, {"id": 8, "text": "notice two", "oneLine": "two"}]),
        )
        self.assertEqual(session_brief._board_start_slice(completed)[1], ["7", "8"])

    def test_board_start_slice_accepts_hosted_uuid_ids(self):
        hosted = "01990000-0000-7000-8000-000000000099"
        completed = SimpleNamespace(
            returncode=0,
            stdout=json.dumps([{"id": hosted, "text": "hosted notice", "oneLine": "hosted"}]),
        )
        self.assertEqual(session_brief._board_start_slice(completed)[1], [hosted])
        self.assertTrue(session_brief._valid_notice_id(f"board:{hosted}"))

    def test_board_start_slice_accepts_delivery_envelope_and_renders_warning(self):
        completed = SimpleNamespace(
            returncode=0,
            stdout=json.dumps({
                "notices": [{"id": "7", "text": "notice", "oneLine": "title"}],
                "warning": "Hosted board cache is unverified.",
            }),
        )
        self.assertEqual(session_brief._board_start_slice(completed)[:3], ("notice\n\nHosted board cache is unverified.", ["7"], "title\nHosted board cache is unverified."))

    def test_board_start_slice_renders_warning_with_no_notices(self):
        completed = SimpleNamespace(
            returncode=0,
            stdout=json.dumps({
                "notices": [],
                "warning": "Hosted board cache is unverified.",
            }),
        )
        self.assertEqual(session_brief._board_start_slice(completed)[:2], ("Hosted board cache is unverified.", []))

    def test_board_start_slice_reports_a_malformed_response(self):
        completed = SimpleNamespace(
            returncode=0,
            stdout=json.dumps([{"id": "not-an-id", "text": "notice", "oneLine": "title"}]),
        )
        self.assertEqual(session_brief._board_start_slice(completed)[0], "Board could not be read; bottega board read shows it.")

    def test_board_start_slice_reports_a_timed_out_claim(self):
        completed = SimpleNamespace(returncode=-1, stdout="")
        full, ids, titles, count, withheld = session_brief._board_start_slice(completed)
        self.assertEqual(full, "Board could not be read; bottega board read shows it.")
        self.assertEqual((ids, titles, count, withheld), ([], full, 0, 0))

    def test_board_dropped_for_budget_has_no_post_emit_delivery_ids(self):
        board = "board notice " * 30
        context = self.assemble(100, autonomy="protected", board=board, issues="filed issue")
        output = {"hookSpecificOutput": {"additionalContext": context}}
        self.assertEqual(session_brief._emitted_board_ids(output, board, [7]), [])

    def test_included_board_is_stamped_only_after_emission(self):
        board = "board notice"
        context = self.assemble(100, autonomy="protected", board=board)
        output = {"hookSpecificOutput": {"additionalContext": context}}
        self.assertEqual(session_brief._emitted_board_ids(output, board, [7]), [7])

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
            115,
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
        self.assertIn("Dropped filed issues (bottega workflow fix-defect --waiting).", text)
        self.assertNotIn("inbox detail (bottega question inbox)", text)

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
            "Dropped heartbeat and monitor extra (bottega machine monitor).",
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
            "Dropped heartbeat and monitor extra (bottega machine monitor) and "
            "resume table (bottega doc resumes).",
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
        text = "plan: review (project)\nship to: production (merge into main, then promote to production) (user)"
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


class MonitorDelivery(unittest.TestCase):
    def notice(self):
        return {
            "kind": "board-notice",
            "subject": "board:7",
            "detail": "notice",
            "noticeId": "board:7",
            "ownerSession": "session-1",
        }

    def test_accepts_old_list_shape(self):
        self.assertEqual(
            session_brief._monitor_delivery(json.dumps([self.notice()]), "session-1"),
            ([self.notice()], None),
        )

    def test_accepts_new_envelope_shape(self):
        self.assertEqual(
            session_brief._monitor_delivery(
                json.dumps({"notices": [self.notice()], "warning": "cache unverified"}),
                "session-1",
            ),
            ([self.notice()], "cache unverified"),
        )

    def test_warning_only_has_no_notice_to_acknowledge(self):
        self.assertEqual(
            session_brief._monitor_delivery(
                json.dumps({"notices": [], "warning": "cache unverified"}), "session-1"
            ),
            ([], "cache unverified"),
        )

    def test_rejects_invalid_shape(self):
        with self.assertRaisesRegex(ValueError, "invalid monitor notice JSON"):
            session_brief._monitor_delivery(json.dumps({"warning": "missing notices"}), "session-1")

    def test_session_start_monitor_explicitly_skips_board_refresh(self):
        self.assertEqual(
            session_brief._monitor_notice_command("/bin/bottega", skip_board_refresh=True),
            ["/bin/bottega", "machine", "monitor", "--notices", "--json", "--skip-board-refresh"],
        )


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
                    started, log_path, offset = session_brief._start_settings_apply("/bin/bottega")
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
            session_brief._start_settings_apply("/bin/bottega", environment)
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
                    "/bin/bottega", {"BOTTEGA_STATE_HOME": state}
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
        process.args = ["/bin/bottega", "machine", "settings", "apply"]
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
