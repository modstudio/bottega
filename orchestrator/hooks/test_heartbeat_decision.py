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
from datetime import datetime, timedelta, timezone


PATH = Path(__file__).with_name("heartbeat-decision.py")
sys.path.insert(0, str(PATH.parent))
SPEC = importlib.util.spec_from_file_location("heartbeat_decision", PATH)
heartbeat_decision = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(heartbeat_decision)


class HeartbeatDecisionTest(unittest.TestCase):
    def test_live_continuation_uses_turn_number_and_age(self):
        with tempfile.TemporaryDirectory() as root:
            checkout = Path(root)
            hooks = checkout / "orchestrator" / "hooks"
            binary = checkout / "bin"
            hooks.mkdir(parents=True)
            binary.mkdir()
            shutil.copy2(PATH, hooks / PATH.name)
            shutil.copy2(PATH.with_name("inbox_question_decision.py"), hooks)
            shutil.copy2(PATH.with_name("orch-heartbeat.sh"), hooks / "orch-heartbeat.sh")
            shutil.copy2(PATH.with_name("heartbeat-run-observation.py"), hooks)
            root_started = (datetime.now(timezone.utc) - timedelta(hours=4)).isoformat()
            turn_started = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()
            row = json.dumps(
                {
                    "record_id": "01990000-0000-7000-8000-000000000001",
                    "number": 1,
                    "job": "fixture",
                    "agent": "codex",
                    "status": "running",
                    "live_statuses": ["queued", "reserved", "attached", "running", "asking"],
                    "session_id": "fixture-session",
                    "started_at": root_started,
                    "latency_ms": None,
                    "live_member_id": "01990000-0000-7000-8000-000000000002",
                    "live_member_number": 501,
                    "live_member_status": "running",
                    "waiting_for_host_capacity": False,
                    "host_wait_since": None,
                    "stall_state": "healthy",
                    "stall": None,
                    "turns": [
                        {"started_at": root_started, "latency_ms": 1000},
                        {"started_at": turn_started, "latency_ms": None},
                    ],
                }
            )
            fake = binary / "bottega"
            fake.write_text(
                f'''#!/bin/sh
case "$*" in
  "board presence") exit 0 ;;
  "question inbox --all --active --json") printf '[]\\n' ;;
  "run list --live --json") printf '%s\\n' '{row}' ;;
  "machine monitor --notices --json") printf '[]\\n' ;;
  *) exit 0 ;;
esac
''',
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

            waiting = [line for line in completed.stdout.splitlines() if "WAITING" in line]
            self.assertEqual(len(waiting), 1)
            self.assertIn("501/fixture codex running 0m", waiting[0])
            self.assertNotIn(": 1/fixture", waiting[0])

    def test_host_wait_idle_threshold_is_not_a_state_change_and_keepalive_remains(self):
        with tempfile.TemporaryDirectory() as root:
            checkout = Path(root)
            hooks = checkout / "orchestrator" / "hooks"
            binary = checkout / "bin"
            hooks.mkdir(parents=True)
            binary.mkdir()
            shutil.copy2(PATH, hooks / PATH.name)
            shutil.copy2(PATH.with_name("inbox_question_decision.py"), hooks)
            shutil.copy2(PATH.with_name("orch-heartbeat.sh"), hooks / "orch-heartbeat.sh")
            shutil.copy2(PATH.with_name("heartbeat-run-observation.py"), hooks)
            started = (datetime.now(timezone.utc) - timedelta(minutes=6)).isoformat()
            base = {
                "record_id": "01990000-0000-7000-8000-000000000001",
                "number": 1,
                "job": "fixture",
                "agent": "codex",
                "status": "running",
                "live_statuses": ["queued", "reserved", "attached", "running", "asking"],
                "session_id": "fixture-session",
                "started_at": started,
                "latency_ms": None,
                "live_member_id": "01990000-0000-7000-8000-000000000002",
                "live_member_number": 501,
                "live_member_status": "running",
                "waiting_for_host_capacity": True,
                "host_wait_since": started,
                "stall_state": "healthy",
                "stall": None,
                "turns": [{"started_at": started, "latency_ms": None}],
            }
            first_row = json.dumps({**base, "idle": None})
            later_row = json.dumps({**base, "idle": "idle 6m"})
            fake = binary / "bottega"
            fake.write_text(
                f'''#!/bin/sh
case "$*" in
  "board presence") exit 0 ;;
  "question inbox --all --active --json") printf '[]\\n' ;;
  "run list --live --json")
    if [ -f "$FAKE_SECOND_TICK" ]; then
      printf '%s\\n' '{later_row}'
    else
      : >"$FAKE_SECOND_TICK"
      printf '%s\\n' '{first_row}'
    fi ;;
  "machine monitor --notices --json") printf '[]\\n' ;;
  *) exit 0 ;;
esac
''',
                encoding="utf-8",
            )
            fake.chmod(0o755)
            marker = checkout / "second-tick"
            command = ["bash", str(hooks / "orch-heartbeat.sh"), "fixture-session", "0.01", "2"]
            env = {
                **os.environ,
                "ORCH_DB": str(checkout / "absent.db"),
                "FAKE_SECOND_TICK": str(marker),
            }

            unchanged = subprocess.run(
                command, cwd=checkout, env=env, capture_output=True, text=True, timeout=2, check=True
            )
            self.assertEqual(unchanged.stdout.count("WAITING"), 1)

            marker.unlink()
            keepalive = subprocess.run(
                [*command[:-1], "3"],
                cwd=checkout,
                env={**env, "KEEPALIVE_TICKS": "2"},
                capture_output=True,
                text=True,
                timeout=2,
                check=True,
            )
            self.assertEqual(keepalive.stdout.count("WAITING"), 2)

    def test_empty_live_listing_reaches_clear_without_degrading(self):
        with tempfile.TemporaryDirectory() as root:
            checkout = Path(root)
            hooks = checkout / "orchestrator" / "hooks"
            binary = checkout / "bin"
            hooks.mkdir(parents=True)
            binary.mkdir()
            shutil.copy2(PATH, hooks / PATH.name)
            shutil.copy2(PATH.with_name("inbox_question_decision.py"), hooks)
            shutil.copy2(PATH.with_name("orch-heartbeat.sh"), hooks / "orch-heartbeat.sh")
            shutil.copy2(PATH.with_name("heartbeat-run-observation.py"), hooks)
            fake = binary / "bottega"
            fake.write_text(
                """#!/bin/sh
case "$*" in
  "board presence") exit 0 ;;
  "question inbox --all --active --json") printf '[]\\n' ;;
  "run list --live --json") exit 0 ;;
  "machine monitor --notices --json") printf '[]\\n' ;;
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

            self.assertNotIn("DEGRADED", completed.stdout)
            self.assertNotIn("HEARTBEAT ENDED", completed.stdout)

    def test_heartbeat_restarts_after_helper_update_without_reannouncing_state(self):
        with tempfile.TemporaryDirectory() as root:
            checkout = Path(root)
            hooks = checkout / "orchestrator" / "hooks"
            binary = checkout / "bin"
            hooks.mkdir(parents=True)
            binary.mkdir()
            helper = hooks / PATH.name
            shutil.copy2(PATH, helper)
            shutil.copy2(PATH.with_name("inbox_question_decision.py"), hooks)
            shutil.copy2(PATH.with_name("orch-heartbeat.sh"), hooks / "orch-heartbeat.sh")
            shutil.copy2(PATH.with_name("heartbeat-run-observation.py"), hooks)
            started = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()
            row = json.dumps(
                {
                    "record_id": "01990000-0000-7000-8000-000000000001",
                    "number": 1,
                    "job": "fixture",
                    "agent": "codex",
                    "status": "running",
                    "live_statuses": ["queued", "reserved", "attached", "running", "asking"],
                    "session_id": "fixture-session",
                    "started_at": started,
                    "latency_ms": None,
                    "live_member_id": "01990000-0000-7000-8000-000000000002",
                    "live_member_number": 501,
                    "live_member_status": "running",
                    "waiting_for_host_capacity": False,
                    "host_wait_since": None,
                    "stall_state": "healthy",
                    "stall": None,
                    "turns": [{"started_at": started, "latency_ms": None}],
                }
            )
            fake = binary / "bottega"
            fake.write_text(
                f'''#!/bin/sh
case "$*" in
  "board presence") exit 0 ;;
  "question inbox --all --active --json") printf '[]\\n' ;;
  "run list --live --json") printf '%s\\n' '{row}' ;;
  "machine monitor --notices --json")
    if [ ! -f "$FAKE_UPDATED" ]; then
      : >"$FAKE_UPDATED"
      printf '\\n' >>"$FAKE_HEARTBEAT_HELPER"
    fi
    printf '[]\\n' ;;
  *) exit 0 ;;
esac
''',
                encoding="utf-8",
            )
            fake.chmod(0o755)

            completed = subprocess.run(
                ["bash", str(hooks / "orch-heartbeat.sh"), "fixture-session", "0.01", "2"],
                cwd=checkout,
                env={
                    **os.environ,
                    "ORCH_DB": str(checkout / "absent.db"),
                    "FAKE_UPDATED": str(checkout / "updated"),
                    "FAKE_HEARTBEAT_HELPER": str(helper),
                },
                capture_output=True,
                text=True,
                timeout=2,
                check=True,
            )

            self.assertEqual(completed.stdout.count("heartbeat updated on disk; restarting"), 1)
            self.assertEqual(completed.stdout.count("WAITING"), 1, completed.stdout)

    def test_decision_failure_includes_screened_first_stderr_line(self):
        with tempfile.TemporaryDirectory() as root:
            checkout = Path(root)
            hooks = checkout / "orchestrator" / "hooks"
            binary = checkout / "bin"
            hooks.mkdir(parents=True)
            binary.mkdir()
            shutil.copy2(PATH.with_name("orch-heartbeat.sh"), hooks / "orch-heartbeat.sh")
            shutil.copy2(PATH.with_name("heartbeat-run-observation.py"), hooks)
            shutil.copy2(PATH.with_name("inbox_question_decision.py"), hooks)
            (hooks / PATH.name).write_text(
                '''#!/usr/bin/env python3
import sys
if sys.argv[1:] == ["tick"]:
    print("decision exploded", file=sys.stderr)
    print("ignored second line", file=sys.stderr)
    raise SystemExit(7)
reason = next((line for line in sys.stdin.read().splitlines() if line.strip()), "stderr empty")
print(reason)
''',
                encoding="utf-8",
            )
            fake = binary / "bottega"
            fake.write_text(
                '''#!/bin/sh
case "$*" in
  "board presence") exit 0 ;;
  "question inbox --all --active --json") printf '[]\\n' ;;
  "run list --live --json") exit 0 ;;
  "machine monitor --notices --json") printf '[]\\n' ;;
  *) exit 0 ;;
esac
''',
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
                "DEGRADED - heartbeat decision step failed with status 7: decision exploded; continuing to watch.",
                completed.stdout,
            )
            self.assertNotIn("ignored second line", completed.stdout)

    def test_a_chain_finishing_between_ticks_is_announced_once(self):
        self.assert_completion_announcement("ok", None, "FINISHED 8/fixture codex 2.0s")

    def test_a_chain_failing_between_ticks_is_announced_once(self):
        self.assert_completion_announcement(
            "failed", "contract", "FAILED 8/fixture codex contract 2.0s"
        )

    def assert_completion_announcement(self, status, failure_kind, expected):
        with tempfile.TemporaryDirectory() as root:
            checkout = Path(root)
            hooks = checkout / "orchestrator" / "hooks"
            binary = checkout / "bin"
            hooks.mkdir(parents=True)
            binary.mkdir()
            shutil.copy2(PATH, hooks / PATH.name)
            shutil.copy2(PATH.with_name("inbox_question_decision.py"), hooks)
            shutil.copy2(PATH.with_name("orch-heartbeat.sh"), hooks / "orch-heartbeat.sh")
            shutil.copy2(PATH.with_name("heartbeat-run-observation.py"), hooks)
            record_id = "01990000-0000-7000-8000-000000000001"
            member_id = "01990000-0000-7000-8000-000000000002"
            started = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()
            live = json.dumps(
                {
                    "record_id": record_id,
                    "number": 7,
                    "job": "fixture",
                    "agent": "codex",
                    "status": "running",
                    "live_statuses": ["queued", "reserved", "attached", "running", "asking"],
                    "session_id": "fixture-session",
                    "started_at": started,
                    "latency_ms": None,
                    "live_member_id": member_id,
                    "live_member_number": 8,
                    "live_member_status": "running",
                    "waiting_for_host_capacity": False,
                    "host_wait_since": None,
                    "stall_state": "healthy",
                    "stall": None,
                    "turns": [{"started_at": started, "latency_ms": None}],
                }
            )
            terminal = json.dumps(
                {
                    "record_id": record_id,
                    "number": 7,
                    "job": "fixture",
                    "agent": "codex",
                    "status": status,
                    "live_member_status": status,
                    "live_member_id": member_id,
                    "live_member_number": 8,
                    "failure_kind": failure_kind,
                    "latency_ms": 2000,
                }
            )
            fake = binary / "bottega"
            fake.write_text(
                f'''#!/bin/sh
case "$*" in
  "board presence") exit 0 ;;
  "question inbox --all --active --json") printf '[]\\n' ;;
  "run list --live --json")
    if [ -f "$FAKE_LIVE_SEEN" ]; then
      exit 0
    else
      : >"$FAKE_LIVE_SEEN"
      printf '%s\\n' '{live}'
    fi ;;
  "run list --json --id {record_id}") printf '%s\\n' '{terminal}' ;;
  "machine monitor --notices --json") printf '[]\\n' ;;
  *) exit 1 ;;
esac
''',
                encoding="utf-8",
            )
            fake.chmod(0o755)

            completed = subprocess.run(
                ["bash", str(hooks / "orch-heartbeat.sh"), "fixture-session", "0.01", "3"],
                cwd=checkout,
                env={
                    **os.environ,
                    "ORCH_DB": str(checkout / "absent.db"),
                    "FAKE_LIVE_SEEN": str(checkout / "live-seen"),
                },
                capture_output=True,
                text=True,
                timeout=2,
                check=True,
            )

            self.assertEqual(completed.stdout.count(expected), 1, completed.stdout)
            self.assertNotIn("DEGRADED", completed.stdout)

    def test_a_continued_chain_announces_each_terminal_turn(self):
        with tempfile.TemporaryDirectory() as root:
            checkout = Path(root)
            hooks = checkout / "orchestrator" / "hooks"
            binary = checkout / "bin"
            hooks.mkdir(parents=True)
            binary.mkdir()
            for name in (
                PATH.name,
                "orch-heartbeat.sh",
                "heartbeat-run-observation.py",
                "inbox_question_decision.py",
            ):
                shutil.copy2(PATH.with_name(name), hooks)
            root_id = "01990000-0000-7000-8000-000000000001"
            first_id = "01990000-0000-7000-8000-000000000002"
            second_id = "01990000-0000-7000-8000-000000000003"
            keeper_root = "01990000-0000-7000-8000-000000000004"
            keeper_id = "01990000-0000-7000-8000-000000000005"
            started = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()

            def live(member_id, number, record_id=root_id):
                return json.dumps(
                    {
                        "record_id": record_id,
                        "number": 7,
                        "job": "fixture",
                        "agent": "codex",
                        "status": "running",
                        "live_statuses": ["queued", "reserved", "attached", "running", "asking"],
                        "session_id": "fixture-session",
                        "started_at": started,
                        "latency_ms": None,
                        "live_member_id": member_id,
                        "live_member_number": number,
                        "live_member_status": "running",
                        "waiting_for_host_capacity": False,
                        "host_wait_since": None,
                        "stall_state": "healthy",
                        "stall": None,
                        "turns": [{"started_at": started, "latency_ms": None}],
                    }
                )

            keeper = live(keeper_id, 11, keeper_root)

            def terminal(member_id, number):
                return json.dumps(
                    {
                        "record_id": root_id,
                        "number": 7,
                        "job": "fixture",
                        "agent": "codex",
                        "status": "ok",
                        "live_member_id": member_id,
                        "live_member_number": number,
                        "live_member_status": "ok",
                        "latency_ms": 2000,
                    }
                )

            fake = binary / "bottega"
            fake.write_text(
                f'''#!/bin/sh
case "$*" in
  "board presence") exit 0 ;;
  "question inbox --all --active --json") printf '[]\\n' ;;
  "run list --live --json")
    if [ ! -f "$FAKE_FIRST_LIVE" ]; then
      : >"$FAKE_FIRST_LIVE"; printf '%s\\n' '{live(first_id, 8)}' '{keeper}'
    elif [ ! -f "$FAKE_FIRST_MISSING" ]; then
      : >"$FAKE_FIRST_MISSING"; printf '%s\\n' '{keeper}'
    elif [ ! -f "$FAKE_SECOND_LIVE" ]; then
      : >"$FAKE_SECOND_LIVE"; printf '%s\\n' '{live(second_id, 9)}' '{keeper}'
    else
      printf '%s\\n' '{keeper}'
    fi ;;
  "run list --json --id {root_id}")
    if [ -f "$FAKE_SECOND_LIVE" ]; then
      printf '%s\\n' '{terminal(second_id, 9)}'
    else
      printf '%s\\n' '{terminal(first_id, 8)}'
    fi ;;
  "machine monitor --notices --json") printf '[]\\n' ;;
  *) exit 1 ;;
esac
''',
                encoding="utf-8",
            )
            fake.chmod(0o755)
            env = {
                **os.environ,
                "ORCH_DB": str(checkout / "absent.db"),
                "FAKE_FIRST_LIVE": str(checkout / "first-live"),
                "FAKE_FIRST_MISSING": str(checkout / "first-missing"),
                "FAKE_SECOND_LIVE": str(checkout / "second-live"),
            }
            completed = subprocess.run(
                ["bash", str(hooks / "orch-heartbeat.sh"), "fixture-session", "0.01", "4"],
                cwd=checkout,
                env=env,
                capture_output=True,
                text=True,
                timeout=2,
                check=True,
            )

            self.assertEqual(completed.stdout.count("FINISHED 8/fixture codex 2.0s"), 1)
            self.assertEqual(completed.stdout.count("FINISHED 9/fixture codex 2.0s"), 1)

    def test_relative_path_restart_carries_live_chain_into_completion(self):
        with tempfile.TemporaryDirectory() as root:
            checkout = Path(root)
            hooks = checkout / "orchestrator" / "hooks"
            binary = checkout / "bin"
            hooks.mkdir(parents=True)
            binary.mkdir()
            for name in (
                PATH.name,
                "orch-heartbeat.sh",
                "heartbeat-run-observation.py",
                "inbox_question_decision.py",
            ):
                shutil.copy2(PATH.with_name(name), hooks)
            root_id = "01990000-0000-7000-8000-000000000001"
            member_id = "01990000-0000-7000-8000-000000000002"
            started = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()
            live = json.dumps(
                {
                    "record_id": root_id,
                    "number": 7,
                    "job": "fixture",
                    "agent": "codex",
                    "status": "running",
                    "live_statuses": ["queued", "reserved", "attached", "running", "asking"],
                    "session_id": "fixture-session",
                    "started_at": started,
                    "latency_ms": None,
                    "live_member_id": member_id,
                    "live_member_number": 8,
                    "live_member_status": "running",
                    "waiting_for_host_capacity": False,
                    "host_wait_since": None,
                    "stall_state": "healthy",
                    "stall": None,
                    "turns": [{"started_at": started, "latency_ms": None}],
                }
            )
            terminal = json.dumps(
                {
                    "record_id": root_id,
                    "number": 7,
                    "job": "fixture",
                    "agent": "codex",
                    "status": "ok",
                    "live_member_id": member_id,
                    "live_member_number": 8,
                    "live_member_status": "ok",
                    "latency_ms": 2000,
                }
            )
            fake = binary / "bottega"
            fake.write_text(
                f'''#!/bin/sh
case "$*" in
  "board presence") exit 0 ;;
  "question inbox --all --active --json") printf '[]\\n' ;;
  "run list --live --json")
    if [ ! -f "$FAKE_LIVE_SEEN" ]; then
      : >"$FAKE_LIVE_SEEN"; printf '%s\\n' '{live}'
    fi ;;
  "run list --json --id {root_id}") printf '%s\\n' '{terminal}' ;;
  "machine monitor --notices --json")
    if [ ! -f "$FAKE_UPDATED" ]; then
      : >"$FAKE_UPDATED"; printf '\\n' >>"$FAKE_OBSERVATION_HELPER"
    fi
    printf '[]\\n' ;;
  *) exit 1 ;;
esac
''',
                encoding="utf-8",
            )
            fake.chmod(0o755)
            completed = subprocess.run(
                ["bash", "orchestrator/hooks/orch-heartbeat.sh", "fixture-session", "0.01", "2"],
                cwd=checkout,
                env={
                    **os.environ,
                    "ORCH_DB": str(checkout / "absent.db"),
                    "FAKE_LIVE_SEEN": str(checkout / "live-seen"),
                    "FAKE_UPDATED": str(checkout / "updated"),
                    "FAKE_OBSERVATION_HELPER": str(hooks / "heartbeat-run-observation.py"),
                },
                capture_output=True,
                text=True,
                timeout=2,
                check=True,
            )

            self.assertEqual(completed.stdout.count("heartbeat updated on disk; restarting"), 1)
            self.assertEqual(completed.stdout.count("FINISHED 8/fixture codex 2.0s"), 1)
            self.assertNotIn("DEGRADED", completed.stdout)

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
            shutil.copy2(PATH.with_name("heartbeat-run-observation.py"), hooks)
            fake = binary / "bottega"
            fake.write_text(
                """#!/bin/sh
case \"$*\" in
  \"board presence\") exit 0 ;;
  \"question inbox --all --active --json\") printf '[]\\n' ;;
  \"run list --live --json\") exit 0 ;;
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

    def test_own_parked_workflow_question_is_waiting(self):
        decision = heartbeat_decision.heartbeat_decision(
            "12:34:56",
            [{"kind": "workflow", "question_id": 8, "session_id": "own", "can_answer": True}],
            0,
            0,
            0,
            "",
            "",
        )
        self.assertIn("WAITING", decision.lines[0])
        self.assertIn("1 parked workflow ruling(s)", decision.lines[0])

    def test_foreign_question_is_not_counted(self):
        decision = heartbeat_decision.heartbeat_decision(
            "12:34:56", [self.worker_question(can_answer=False)], 0, 0, 0, "", ""
        )
        self.assertTrue(decision.should_exit)
        self.assertEqual(decision.lines, [])

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
                shutil.copy2(PATH.with_name("heartbeat-run-observation.py"), hooks)
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
  \"run list --live --json\") exit 0 ;;
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
