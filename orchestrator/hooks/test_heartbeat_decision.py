import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import unittest


PATH = Path(__file__).with_name("heartbeat-decision.py")
SPEC = importlib.util.spec_from_file_location("heartbeat_decision", PATH)
heartbeat_decision = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(heartbeat_decision)


class HeartbeatDecisionTest(unittest.TestCase):
    def test_one_tick_reports_blocked_and_stalled_once(self):
        lines = heartbeat_decision.heartbeat_lines("12:34:56", 1, 2, 0, 1, "run 7 idle", "ignored")
        self.assertEqual(len(lines), 2)
        self.assertIn("BLOCKED - 1 question(s)", lines[0])
        self.assertEqual(lines[1], "[12:34:56] STALLED - 1 run(s): run 7 idle")

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
  \"question inbox --all --json\") printf '[]\\n' ;;
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
