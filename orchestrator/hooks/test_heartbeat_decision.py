import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest


PATH = Path(__file__).with_name("heartbeat-decision.py")
sys.path.insert(0, str(PATH.parent))
SPEC = importlib.util.spec_from_file_location("heartbeat_decision", PATH)
heartbeat_decision = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(heartbeat_decision)


class HeartbeatDecisionTest(unittest.TestCase):
    def test_shared_inbox_decision_imports_with_minimal_path_python(self):
        minimal_path = "/usr/bin:/bin"
        python = shutil.which("python3", path=minimal_path)
        self.assertIsNotNone(python, "minimal PATH has no system python3")
        subprocess.run(
            [python, str(PATH.with_name("inbox_question_decision.py"))],
            env={"PATH": minimal_path},
            capture_output=True,
            text=True,
            check=True,
        )

    def test_heartbeat_formats_a_monitor_notice_with_its_label_once(self):
        with tempfile.TemporaryDirectory() as root:
            checkout = Path(root)
            hooks = checkout / "orchestrator" / "hooks"
            binary = checkout / "bin"
            hooks.mkdir(parents=True)
            binary.mkdir()
            shutil.copy2(PATH, hooks / PATH.name)
            shutil.copy2(PATH.with_name("inbox_question_decision.py"), hooks)
            shutil.copy2(PATH.with_name("orch-heartbeat.sh"), hooks / "orch-heartbeat.sh")
            fake = binary / "bottega"
            fake.write_text(
                """#!/bin/sh
case \"$*\" in
  \"board presence\") exit 0 ;;
  \"question inbox --all --active --json\") printf '[]\\n' ;;
  \"run list --limit 200 --json\")
    printf '%s\\n' '{\"record_id\":\"01990000-0000-7000-8000-000000000001\",\"number\":1,\"job\":\"fixture\",\"agent\":\"codex\",\"status\":\"ok\",\"session_id\":\"other\",\"started_at\":\"2026-01-01T00:00:00Z\",\"latency_ms\":1}' ;;
  \"machine monitor --notices --json\")
    printf '%s\\n' '[{\"noticeId\":\"condition:1\",\"kind\":\"worker-gate-tooling-change\",\"subject\":\"run:01990000-0000-7000-8000-000000000002\",\"label\":\"run 16709\",\"detail\":\"detected (age unknown, status ok, project bottega); inspect the run deliberately.\",\"ownerSession\":\"fixture-session\"}]' ;;
  \"machine monitor --ack-notices condition:1\") exit 0 ;;
  *) exit 0 ;;
esac
""",
                encoding="utf-8",
            )
            fake.chmod(0o755)

            completed = subprocess.run(
                ["bash", str(hooks / "orch-heartbeat.sh"), "fixture-session", "0.01", "1"],
                cwd=checkout,
                env={**os.environ, "ORCH_DB": str(checkout / "absent.db")},
                capture_output=True,
                text=True,
                timeout=2,
                check=True,
            )

            self.assertIn(
                "MONITOR worker-gate-tooling-change run 16709: detected (age unknown, status ok, project bottega); inspect the run deliberately.",
                completed.stdout.splitlines(),
            )
            self.assertNotIn("run:01990000", completed.stdout)

    def test_one_tick_reports_blocked_and_stalled_once(self):
        decision = heartbeat_decision.heartbeat_decision(
            "12:34:56", [self.worker_question()], 2, 0, 1, "run 7 idle", "ignored"
        )
        self.assertEqual(len(decision.lines), 2)
        self.assertIn("BLOCKED - 1 question(s)", decision.lines[0])
        self.assertEqual(decision.lines[1], "[12:34:56] STALLED - 1 run(s): run 7 idle")

    def test_live_runs_keep_looping(self):
        decision = heartbeat_decision.heartbeat_decision(
            "12:34:56", [], 1, 0, 0, "", "run 7 live"
        )
        self.assertFalse(decision.should_exit)
        self.assertIn("WAITING - 1 run(s) and 0 landing(s)", decision.lines[0])

    def test_live_landings_only_keep_looping(self):
        decision = heartbeat_decision.heartbeat_decision(
            "12:34:56", [], 0, 1, 0, "", "landing live"
        )
        self.assertFalse(decision.should_exit)
        self.assertIn("WAITING - 0 run(s) and 1 landing(s)", decision.lines[0])

    def test_asking_keeps_looping(self):
        decision = heartbeat_decision.heartbeat_decision(
            "12:34:56", [self.worker_question()], 0, 0, 0, "", ""
        )
        self.assertFalse(decision.should_exit)
        self.assertIn("BLOCKED - 1 question(s)", decision.lines[0])

    def test_stalled_keeps_looping(self):
        decision = heartbeat_decision.heartbeat_decision(
            "12:34:56", [], 0, 0, 1, "run 7 idle", ""
        )
        self.assertFalse(decision.should_exit)
        self.assertIn("STALLED - 1 run(s)", decision.lines[0])

    def test_nothing_live_exits(self):
        decision = heartbeat_decision.heartbeat_decision("12:34:56", [], 0, 0, 0, "", "")
        self.assertTrue(decision.should_exit)
        self.assertEqual(decision.lines, [])

    @staticmethod
    def worker_question(**overrides):
        question = {"question_id": 7, "can_answer": True}
        question.update(overrides)
        return question

    def test_own_worker_question_is_blocked(self):
        decision = heartbeat_decision.heartbeat_decision(
            "12:34:56", [self.worker_question()], 1, 0, 0, "", "run 7 asking"
        )
        self.assertIn("BLOCKED - 1 question(s)", decision.lines[0])

    def test_own_workflow_question_is_blocked(self):
        decision = heartbeat_decision.heartbeat_decision(
            "12:34:56",
            [
                {"kind": "workflow", "question_id": 8, "session_id": "own", "can_answer": True},
                {
                    "kind": "workflow",
                    "question_id": 1936,
                    "session_id": "eaabda0a",
                    "can_answer": False,
                },
            ],
            0,
            0,
            0,
            "",
            "",
        )
        self.assertFalse(decision.should_exit)
        self.assertIn("BLOCKED - 1 question(s)", decision.lines[0])

    def test_foreign_workflow_question_is_not_blocked(self):
        decision = heartbeat_decision.heartbeat_decision(
            "12:34:56",
            [
                {
                    "kind": "workflow",
                    "question_id": 1936,
                    "session_id": "eaabda0a",
                    "can_answer": False,
                    "ownership_notice": (
                        "owned by session eaabda0a; only that session, or the operator "
                        "relaying a decision, may answer it"
                    ),
                }
            ],
            0,
            0,
            0,
            "",
            "",
        )
        self.assertTrue(decision.should_exit)
        self.assertEqual(decision.lines, [])

    def test_foreign_question_is_not_counted(self):
        decision = heartbeat_decision.heartbeat_decision(
            "12:34:56", [self.worker_question(can_answer=False)], 0, 0, 0, "", ""
        )
        self.assertTrue(decision.should_exit)
        self.assertEqual(decision.lines, [])

    def test_foreign_workflow_does_not_add_to_an_own_run_question(self):
        decision = heartbeat_decision.heartbeat_decision(
            "12:34:56",
            [
                self.worker_question(),
                {
                    "kind": "workflow",
                    "question_id": 1936,
                    "session_id": "eaabda0a",
                    "can_answer": False,
                },
            ],
            0,
            0,
            0,
            "",
            "",
        )
        self.assertIn("BLOCKED - 1 question(s)", decision.lines[0])

    def test_duplicate_question_rows_count_once(self):
        question = self.worker_question()
        decision = heartbeat_decision.heartbeat_decision(
            "12:34:56", [question, question], 0, 0, 0, "", ""
        )
        self.assertIn("BLOCKED - 1 question(s)", decision.lines[0])

    def test_failure_reason_is_bounded_to_the_first_printable_line(self):
        reason = heartbeat_decision.monitor_failure_reason(
            b"hosted\tnotice query unavailable\nignored second line\n"
        )
        self.assertEqual(reason, "hostednotice query unavailable")
        self.assertEqual(
            len(heartbeat_decision.monitor_failure_reason((b"ab-" * 100) + b"\n")),
            heartbeat_decision.NOTICE_REASON_MAX_CHARS,
        )

    def test_failure_reason_distinguishes_empty_and_nonprintable_stderr(self):
        self.assertEqual(heartbeat_decision.monitor_failure_reason(b""), "stderr empty")
        self.assertEqual(
            heartbeat_decision.monitor_failure_reason(b"\x00\x01\x02"), "stderr not printable"
        )
        self.assertEqual(
            heartbeat_decision.monitor_failure_reason(b"\x1b[2Junavailable"), "[2Junavailable"
        )

    def test_failure_reason_withholds_secret_shapes(self):
        for value in (
            b"token=example-credential",
            b"Authorization: example-credential",
            b"Bearer example-credential",
            b"https://user:pass@example.test",
            b"Authorization: Bearer example-credential",
        ):
            self.assertEqual(
                heartbeat_decision.monitor_failure_reason(value),
                "reason withheld (secret-shaped)",
            )

    def test_secret_detector_matches_the_shared_canonical_fixtures(self):
        fixture_path = PATH.parents[2] / "shared" / "secret-shaped-fixtures.json"
        fixtures = json.loads(fixture_path.read_text(encoding="utf-8"))
        for fixture in fixtures:
            with self.subTest(fixture["name"]):
                self.assertEqual(
                    heartbeat_decision.contains_secret_shaped("".join(fixture["parts"])),
                    fixture["secret"],
                )

    def test_term_and_int_reap_the_guarded_monitor_and_watchdog(self):
        for sent_signal in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(sent_signal=sent_signal), tempfile.TemporaryDirectory() as root:
                checkout = Path(root)
                hooks = checkout / "orchestrator" / "hooks"
                binary = checkout / "bin"
                hooks.mkdir(parents=True)
                binary.mkdir()
                shutil.copy2(PATH, hooks / PATH.name)
                shutil.copy2(PATH.with_name("inbox_question_decision.py"), hooks)
                heartbeat_fixture = hooks / "orch-heartbeat.sh"
                heartbeat_source = PATH.with_name("orch-heartbeat.sh").read_text(encoding="utf-8")
                heartbeat_fixture.write_text(
                    heartbeat_source.replace(
                        "  WATCHDOG_PID=$!\n",
                        '  WATCHDOG_PID=$!\n  echo "$WATCHDOG_PID" >"$FAKE_WATCHDOG_PID_FILE"\n',
                        1,
                    ),
                    encoding="utf-8",
                )
                monitor_pid_file = checkout / "monitor.pid"
                watchdog_pid_file = checkout / "watchdog.pid"
                fake = binary / "bottega"
                fake.write_text(
                    """#!/bin/sh
case \"$*\" in
  \"board presence\") exit 0 ;;
  \"question inbox --all --active --json\") printf '[]\\n' ;;
  \"run list --limit 200 --json\")
    printf '%s\\n' '{\"record_id\":\"01990000-0000-7000-8000-000000000001\",\"number\":1,\"job\":\"fixture\",\"agent\":\"codex\",\"status\":\"ok\",\"session_id\":\"other\",\"started_at\":\"2026-01-01T00:00:00Z\",\"latency_ms\":1}' ;;
  \"machine monitor --notices --json\") echo $$ >\"$FAKE_MONITOR_PID_FILE\"; sleep 30 ;;
  *) exit 0 ;;
esac
""",
                    encoding="utf-8",
                )
                fake.chmod(0o755)
                environment = {
                    **os.environ,
                    "ORCH_DB": str(checkout / "absent.db"),
                    "NOTICE_TIMEOUT_SECONDS": "30",
                    "FAKE_MONITOR_PID_FILE": str(monitor_pid_file),
                    "FAKE_WATCHDOG_PID_FILE": str(watchdog_pid_file),
                }
                heartbeat = subprocess.Popen(
                    ["bash", str(heartbeat_fixture), "fixture-session", "0.01", "2"],
                    cwd=checkout,
                    env=environment,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                try:
                    deadline = time.monotonic() + 0.7
                    while (
                        not monitor_pid_file.exists() or not watchdog_pid_file.exists()
                    ) and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertTrue(monitor_pid_file.exists(), "guarded monitor did not start")
                    self.assertTrue(watchdog_pid_file.exists(), "watchdog did not start")
                    monitor_pid = int(monitor_pid_file.read_text(encoding="utf-8"))
                    watchdog_pid = int(watchdog_pid_file.read_text(encoding="utf-8"))

                    heartbeat.send_signal(sent_signal)
                    heartbeat.wait(timeout=0.7)
                    self.assertEqual(
                        heartbeat.returncode,
                        143 if sent_signal == signal.SIGTERM else 130,
                    )
                    for pid in (monitor_pid, watchdog_pid):
                        with self.assertRaises(ProcessLookupError):
                            os.kill(pid, 0)
                finally:
                    if heartbeat.poll() is None:
                        heartbeat.kill()
                        heartbeat.wait()


if __name__ == "__main__":
    unittest.main()
