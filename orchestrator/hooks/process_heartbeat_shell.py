"""Every heartbeat case here drives a real child process, so it is CI-only.

The heartbeat shell, the observation helpers it calls and the signal-driven reap
all cost wall time and spawn processes, which belongs to runtime monitoring
rather than the in-process gate: `.agents/rules/30-tests.md` keeps spawning out
of the gate and names signals and exit codes as runtime-monitoring work. The
gate's own discovery (`test_*.py`) therefore never picks this file up, and
`scripts/check-plan.ts` runs it in CI as the `orchestrator-hooks-process` job.
"""

import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone

from heartbeat_decision_fixture import PATH

SUCCESSOR = {"number": 900, "agent": "grok"}

# Guards for the child waits below, each sized from measured healthy runs: every
# case was timed on its own over six runs, and each constant names the slowest
# healthy wait of the kind it guards. A guard is four times that wait, rounded
# up to a whole second and never below two seconds, because a guard finer than a
# couple of seconds measures a cold runner's process launch rather than a hang.
SHELL_RUN_GUARD_SECONDS = 5  # one orch-heartbeat.sh run; slowest healthy 1.20s
FOUR_TICK_GUARD_SECONDS = 15  # one four-tick orch-heartbeat.sh run; slowest healthy 3.73s
HELPER_RUN_GUARD_SECONDS = 2  # one observation helper child; slowest healthy 0.02s
REAP_START_GUARD_SECONDS = 2  # the monitor and the watchdog starting; slowest healthy 0.25s
REAP_EXIT_GUARD_SECONDS = 2  # the signaled heartbeat leaving; slowest healthy 0.01s

_SHELL_TEMP = {}


def setUpModule():
    """Point every fixture shell's `mktemp` at a directory this module owns.

    The hook screens every read through a `mktemp` file, and a confined runner
    may deny the machine temporary directory `mktemp` prefers, where a bare
    `mktemp` then fails and degrades every tick. Every fixture builds its child
    environment from `os.environ`, so installing the shim there for the module
    carries it into all of them; tearDownModule restores the environment.
    """
    real_mktemp = shutil.which("mktemp")
    if not real_mktemp:
        return
    directory = Path(tempfile.mkdtemp(prefix="heartbeat-shell-temp-"))
    shim = directory / "mktemp"
    shim.write_text(
        f'''#!/bin/sh
exec {real_mktemp} -p "$MKTEMP_DIR" "$@"
''',
        encoding="utf-8",
    )
    shim.chmod(0o755)
    _SHELL_TEMP.update(
        directory=directory,
        path=os.environ.get("PATH"),
        mktemp_dir=os.environ.get("MKTEMP_DIR"),
    )
    os.environ["PATH"] = f"{directory}{os.pathsep}{os.environ['PATH']}"
    os.environ["MKTEMP_DIR"] = str(directory)


def tearDownModule():
    if not _SHELL_TEMP:
        return
    for name, key in (("PATH", "path"), ("MKTEMP_DIR", "mktemp_dir")):
        if _SHELL_TEMP[key] is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = _SHELL_TEMP[key]
    shutil.rmtree(_SHELL_TEMP["directory"], ignore_errors=True)
    _SHELL_TEMP.clear()


class GuardedChildTest(unittest.TestCase):
    """Run each child under the guard measured for the wait it is doing."""

    def run_shell(self, wait, argv, **kwargs):
        """One `orch-heartbeat.sh` run, guarded as one heartbeat tick."""
        return self.guard(wait, SHELL_RUN_GUARD_SECONDS, argv, **kwargs)

    def run_shell_four_ticks(self, wait, argv, **kwargs):
        """One `orch-heartbeat.sh` run of four ticks, guarded as a four-tick run."""
        return self.guard(wait, FOUR_TICK_GUARD_SECONDS, argv, **kwargs)

    def run_helper(self, wait, argv, **kwargs):
        """One heartbeat helper process, guarded as one helper child."""
        return self.guard(wait, HELPER_RUN_GUARD_SECONDS, argv, **kwargs)

    def guard(self, wait, guard_seconds, argv, **kwargs):
        """Run one child; a wait that hangs fails naming this case and the wait."""
        try:
            return subprocess.run(argv, timeout=guard_seconds, **kwargs)
        except subprocess.TimeoutExpired:
            raise AssertionError(self.hung(wait, guard_seconds)) from None

    def wait_for_child(self, wait, guard_seconds, process):
        """Wait for a child started by hand, under the guard measured for it."""
        try:
            process.wait(timeout=guard_seconds)
        except subprocess.TimeoutExpired:
            raise AssertionError(self.hung(wait, guard_seconds)) from None

    def wait_until(self, wait, guard_seconds, condition):
        """Poll for what a child should reach, under the guard measured for it."""
        deadline = time.monotonic() + guard_seconds
        while not condition() and time.monotonic() < deadline:
            time.sleep(0.01)
        if not condition():
            raise AssertionError(self.hung(wait, guard_seconds))

    def hung(self, wait, guard_seconds):
        return f"{self._testMethodName} hung waiting for {wait} ({guard_seconds}s guard)"


class HeartbeatShellProcessTest(GuardedChildTest):
    """Cases that drive the heartbeat shell and the children it starts."""

    def test_shell_keeps_open_request_waiting_until_external_reply_is_delivered(self):
        with tempfile.TemporaryDirectory() as root:
            checkout = Path(root)
            hooks = checkout / "orchestrator" / "hooks"
            binary = checkout / "bin"
            hooks.mkdir(parents=True)
            binary.mkdir()
            for name in (
                "heartbeat-decision.py",
                "heartbeat-board-observation.py",
                "heartbeat-run-observation.py",
                "inbox_question_decision.py",
                "notice_transport.py",
                "orch-heartbeat.sh",
            ):
                shutil.copy2(PATH.with_name(name), hooks / name)

            store = checkout / "orchestrator.db"
            connection = sqlite3.connect(store)
            connection.executescript(
                """
                CREATE TABLE landing (
                  record_id TEXT PRIMARY KEY, branch TEXT, status TEXT,
                  started_at TEXT, finished_at TEXT, session_id TEXT
                );
                CREATE TABLE board_message (
                  record_id TEXT PRIMARY KEY, number INTEGER, kind TEXT, purpose TEXT,
                  author_session TEXT, title TEXT, expires_at TEXT, withdrawn_at TEXT,
                  thread_root_record_id TEXT
                );
                CREATE TABLE board_receipt (
                  message_record_id TEXT, reader_session TEXT, delivered_at TEXT
                );
                CREATE TABLE hosted_board_message_cache (
                  id TEXT PRIMARY KEY, kind TEXT, thread_root_id TEXT, payload TEXT
                );
                CREATE TABLE hosted_board_receipt_cache (
                  message_id TEXT, reader_session TEXT, delivered_at TEXT
                );
                """
            )
            connection.execute(
                "INSERT INTO board_message VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    "root-1", 12, "notice", "request", "fixture-session",
                    "Need a ruling", "2099-01-15T09:00:00.000Z", None, None,
                ),
            )
            connection.commit()
            connection.close()

            fake = binary / "bottega"
            fake.write_text(
                """#!/bin/sh
case "$*" in
  "board presence") exit 0 ;;
  "question inbox --all --active --json") printf '[]\\n' ;;
  "run list --live --json") exit 0 ;;
  "machine monitor --notices --json"|"machine monitor --notices --json --skip-board-refresh") printf '[]\\n' ;;
  *) exit 0 ;;
esac
""",
                encoding="utf-8",
            )
            fake.chmod(0o755)

            def heartbeat():
                return self.run_shell(
                    "one fixture tick run",
                    ["bash", str(hooks / "orch-heartbeat.sh"), "fixture-session", "0.01", "1"],
                    cwd=checkout,
                    env={**os.environ, "BOTTEGA_ORCHESTRATOR_DB": str(store)},
                    capture_output=True,
                    text=True,
                    check=True,
                )

            waiting = heartbeat()
            self.assertIn("WAITING", waiting.stdout)
            self.assertIn("board:12 Need a ruling", waiting.stdout)

            connection = sqlite3.connect(store)
            connection.execute(
                "INSERT INTO board_message VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    "reply-1", 13, "reply", None, "answering-session",
                    None, None, None, "root-1",
                ),
            )
            connection.execute(
                "INSERT INTO board_receipt VALUES (?,?,?)",
                ("reply-1", "fixture-session", "2027-01-15T08:00:00.000Z"),
            )
            connection.commit()
            connection.close()

            released = heartbeat()
            self.assertNotIn("board:12 Need a ruling", released.stdout)
    def test_live_operational_status_uses_the_row_wording(self):
        base = {
            "record_id": "01990000-0000-7000-8000-000000000001",
            "number": 1,
            "job": "fixture",
            "agent": "codex",
            "status": "running",
            "live_statuses": ["queued", "reserved", "attached", "running", "asking"],
            "session_id": "fixture-session",
            "started_at": "2026-10-21T12:00:00.000Z",
            "latency_ms": None,
            "live_member_id": "01990000-0000-7000-8000-000000000002",
            "live_member_number": 501,
            "live_member_status": "running",
            "waiting_for_host_capacity": False,
            "host_wait_since": None,
            "stall_state": "healthy",
            "stall": None,
        }
        cases = (
            {
                "waiting_for_capacity": True,
                "throttled": None,
                "live_status_detail": "waiting for capacity since 2026-10-21T12:00:00.000Z",
            },
            {
                "waiting_for_capacity": False,
                "throttled": {"attempt": 1, "max": 5, "status": 429},
                "live_status_detail": "throttled (429), retry 1/5 at 2026-10-21T12:04:45.000Z",
            },
        )
        for operational in cases:
            with self.subTest(detail=operational["live_status_detail"]):
                completed = self.run_helper(
                    "the live status observation helper",
                    [
                        sys.executable,
                        str(PATH.with_name("heartbeat-run-observation.py")),
                        "live",
                        "fixture-session",
                    ],
                    input=json.dumps({**base, **operational}) + "\n",
                    capture_output=True,
                    text=True,
                    check=True,
                )
                self.assertIn(operational["live_status_detail"], completed.stdout)
    def test_completion_keeps_a_failed_root_watched_only_inside_its_window(self):
        root = "01990000-0000-7000-8000-000000000001"
        member = "01990000-0000-7000-8000-000000000002"
        failed = {
            "record_id": root,
            "number": 7,
            "job": "fixture",
            "agent": "codex",
            "status": "failed",
            "live_member_status": "failed",
            "live_member_id": member,
            "live_member_number": 8,
            "failure_kind": "contract",
            "latency_ms": 2000,
            "started_at": "2026-10-23T21:00:00.000Z",
        }
        # The listing's published window decides; the observer only holds its
        # own observation instant against it.
        observed_at = int(datetime(2026, 10, 23, 21, 30, tzinfo=timezone.utc).timestamp() * 1000)
        cases = (
            ("2026-10-23T21:45:00.000Z", root),
            ("2026-10-23T21:15:00.000Z", ""),
            (None, ""),
        )
        for watch_until, expected in cases:
            with self.subTest(watch_until=watch_until):
                completed = self.run_helper(
                    "the completion observation helper",
                    [
                        sys.executable,
                        str(PATH.with_name("heartbeat-run-observation.py")),
                        "completion",
                        root,
                        "",
                        "queued,reserved,attached,running,asking",
                    ],
                    input=json.dumps({**failed, "automatic_failover_watch_until": watch_until}) + "\n",
                    capture_output=True,
                    text=True,
                    check=True,
                    env={**os.environ, "BOTTEGA_HEARTBEAT_NOW_MS": str(observed_at)},
                )
                watch = [
                    line
                    for line in completed.stdout.splitlines()
                    if line.startswith("WATCH\t")
                ]
                self.assertEqual(watch, ["WATCH\t" + expected], completed.stdout)
    def test_completion_drops_a_watched_root_that_went_live_again_without_a_line(self):
        """A watched failure that was continued leaves the watch silently.

        A root the caller has just watched disappear must be terminal, so a live
        member there stays an error. A root already under watch may instead have
        been continued; then it is not lost, and its next terminal is announced
        as usual rather than as a stale failover.
        """
        root = "01990000-0000-7000-8000-000000000001"
        member = "01990000-0000-7000-8000-000000000002"
        failed = {
            "record_id": root,
            "number": 7,
            "job": "fixture",
            "agent": "codex",
            "status": "failed",
            "live_member_status": "failed",
            "live_member_id": member,
            "live_member_number": 8,
            "failure_kind": "contract",
            "latency_ms": 2000,
            "started_at": "2026-10-23T21:00:00.000Z",
            "automatic_failover_successor": None,
            "automatic_failover_watch_until": "2026-10-23T21:45:00.000Z",
        }
        live_again = {**failed, "live_member_status": "running", "status": "running"}
        live_statuses = "queued,reserved,attached,running,asking"
        observed_at = int(datetime(2026, 10, 23, 21, 30, tzinfo=timezone.utc).timestamp() * 1000)

        def observe(expected, watched, row):
            return self.run_helper(
                "the completion observation helper",
                [
                    sys.executable,
                    str(PATH.with_name("heartbeat-run-observation.py")),
                    "completion",
                    expected,
                    watched,
                    live_statuses,
                ],
                input=json.dumps(row) + "\n",
                capture_output=True,
                text=True,
                env={**os.environ, "BOTTEGA_HEARTBEAT_NOW_MS": str(observed_at)},
            )

        continued = observe("", root, live_again)
        self.assertEqual(continued.returncode, 0, continued.stderr)
        self.assertNotIn("EVENT", continued.stdout)
        self.assertEqual(continued.stdout, "WATCH\t\n")

        # A root the caller watched disappear is still held to being terminal.
        disappeared = observe(root, "", live_again)
        self.assertEqual(disappeared.returncode, 2, disappeared.stdout)

        # A watched root still waiting on a successor keeps its place. Its EVENT
        # row repeats, as it always did; the heartbeat deduplicates by member id.
        still_watched = observe("", root, failed)
        self.assertEqual(still_watched.returncode, 0, still_watched.stderr)
        self.assertIn("WATCH\t" + root + "\n", still_watched.stdout)
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
            shutil.copy2(PATH.with_name("heartbeat-board-observation.py"), hooks)
            shutil.copy2(PATH.with_name("heartbeat-run-observation.py"), hooks)
            shutil.copy2(PATH.with_name("notice_transport.py"), hooks)
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
  "machine monitor --notices --json"|"machine monitor --notices --json --skip-board-refresh") printf '[]\\n' ;;
  *) exit 0 ;;
esac
''',
                encoding="utf-8",
            )
            fake.chmod(0o755)

            completed = self.run_shell(
                "the single tick run",
                ["bash", str(hooks / "orch-heartbeat.sh"), "fixture-session", "0.01", "1"],
                cwd=checkout,
                env={**os.environ, "BOTTEGA_ORCHESTRATOR_DB": str(checkout / "absent.db")},
                capture_output=True,
                text=True,
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
            shutil.copy2(PATH.with_name("heartbeat-board-observation.py"), hooks)
            shutil.copy2(PATH.with_name("heartbeat-run-observation.py"), hooks)
            shutil.copy2(PATH.with_name("notice_transport.py"), hooks)
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
  "machine monitor --notices --json"|"machine monitor --notices --json --skip-board-refresh") printf '[]\\n' ;;
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
                "BOTTEGA_ORCHESTRATOR_DB": str(checkout / "absent.db"),
                "FAKE_SECOND_TICK": str(marker),
            }

            unchanged = self.run_shell(
                "the two-tick unchanged run",
                command,
                cwd=checkout,
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertEqual(unchanged.stdout.count("WAITING"), 1)

            marker.unlink()
            keepalive = self.run_shell(
                "the three-tick keepalive run",
                [*command[:-1], "3"],
                cwd=checkout,
                env={**env, "KEEPALIVE_TICKS": "2"},
                capture_output=True,
                text=True,
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
            shutil.copy2(PATH.with_name("heartbeat-board-observation.py"), hooks)
            shutil.copy2(PATH.with_name("heartbeat-run-observation.py"), hooks)
            shutil.copy2(PATH.with_name("notice_transport.py"), hooks)
            fake = binary / "bottega"
            fake.write_text(
                """#!/bin/sh
case "$*" in
  "board presence") exit 0 ;;
  "question inbox --all --active --json") printf '[]\\n' ;;
  "run list --live --json") exit 0 ;;
  "machine monitor --notices --json"|"machine monitor --notices --json --skip-board-refresh") printf '[]\\n' ;;
  *) exit 0 ;;
esac
""",
                encoding="utf-8",
            )
            fake.chmod(0o755)

            completed = self.run_shell(
                "the single tick run",
                ["bash", str(hooks / "orch-heartbeat.sh"), "fixture-session", "0.01", "1"],
                cwd=checkout,
                env={**os.environ, "BOTTEGA_ORCHESTRATOR_DB": str(checkout / "absent.db")},
                capture_output=True,
                text=True,
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
            shutil.copy2(PATH.with_name("heartbeat-board-observation.py"), hooks)
            shutil.copy2(PATH.with_name("heartbeat-run-observation.py"), hooks)
            shutil.copy2(PATH.with_name("notice_transport.py"), hooks)
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
  "machine monitor --notices --json"|"machine monitor --notices --json --skip-board-refresh")
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

            completed = self.run_shell(
                "the restarting two-tick run",
                ["bash", str(hooks / "orch-heartbeat.sh"), "fixture-session", "0.01", "2"],
                cwd=checkout,
                env={
                    **os.environ,
                    "BOTTEGA_ORCHESTRATOR_DB": str(checkout / "absent.db"),
                    "FAKE_UPDATED": str(checkout / "updated"),
                    "FAKE_HEARTBEAT_HELPER": str(helper),
                },
                capture_output=True,
                text=True,
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
            shutil.copy2(PATH.with_name("heartbeat-board-observation.py"), hooks)
            shutil.copy2(PATH.with_name("heartbeat-run-observation.py"), hooks)
            shutil.copy2(PATH.with_name("notice_transport.py"), hooks)
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
  "machine monitor --notices --json"|"machine monitor --notices --json --skip-board-refresh") printf '[]\\n' ;;
  *) exit 0 ;;
esac
''',
                encoding="utf-8",
            )
            fake.chmod(0o755)

            completed = self.run_shell(
                "the degraded single tick run",
                ["bash", str(hooks / "orch-heartbeat.sh"), "fixture-session", "0.01", "1"],
                cwd=checkout,
                env={**os.environ, "BOTTEGA_ORCHESTRATOR_DB": str(checkout / "absent.db")},
                capture_output=True,
                text=True,
                check=True,
            )

            self.assertIn(
                "DEGRADED - heartbeat decision step failed with status 7: decision exploded; continuing to watch.",
                completed.stdout,
            )
            self.assertNotIn("ignored second line", completed.stdout)
    def test_a_failed_chain_with_a_successor_names_it_on_the_failed_line(self):
        completed = self.run_failover_fixture(SUCCESSOR)
        self.assertEqual(
            completed.count(
                "FAILED 8/fixture codex contract 2.0s; automatic failover started run 900 on grok"
            ),
            1,
            completed,
        )
        self.assertNotIn("inspect with", completed)
    def test_a_successor_started_after_the_failed_line_is_announced_once(self):
        completed = self.run_failover_fixture(None, SUCCESSOR)
        self.assertEqual(
            completed.count("FAILED 8/fixture codex contract 2.0s; inspect with 'bottega run show 8'"),
            1,
            completed,
        )
        self.assertEqual(
            completed.count(
                "FAILOVER 8/fixture contract; automatic failover started run 900 on grok"
            ),
            1,
            completed,
        )
        self.assertEqual(completed.count("FAILED 8/fixture"), 1, completed)
    def test_a_watched_failure_with_no_successor_stays_quiet(self):
        completed = self.run_failover_fixture(None)
        self.assertEqual(completed.count("FAILED 8/fixture"), 1, completed)
        self.assertEqual(completed.count("FAILOVER"), 0, completed)
    def test_a_successor_appearing_on_a_degraded_tick_is_still_announced_once(self):
        """A degraded tick announces nothing, so it must not spend the watch.

        The root leaves the watch only once its FAILOVER line has been printed.
        A tick that read the successor and then degraded has printed nothing, so
        keeping its reading would drop the root and lose the line for good.
        """
        completed = self.run_failover_fixture(None, SUCCESSOR, degraded_inbox_call=3)
        self.assertEqual(completed.count("FAILED 8/fixture"), 1, completed)
        self.assertIn("DEGRADED", completed)
        self.assertEqual(
            completed.count(
                "FAILOVER 8/fixture contract; automatic failover started run 900 on grok"
            ),
            1,
            completed,
        )
        self.assertLess(
            completed.index("DEGRADED"),
            completed.index("FAILOVER 8/fixture"),
            completed,
        )
    def test_a_watched_failure_continued_live_leaves_the_watch_without_degrading(self):
        """A watched root that goes live again is not a chain that disappeared.

        `bottega run continue` makes the watched root live again. Re-requesting
        it as a disappearance would raise "disappeared chain is still live" on
        every tick while the watch is held, so a watched root whose latest
        member is live leaves the watch silently and its next terminal state is
        announced as usual.
        """
        with tempfile.TemporaryDirectory() as root:
            checkout = Path(root)
            hooks = checkout / "orchestrator" / "hooks"
            binary = checkout / "bin"
            hooks.mkdir(parents=True)
            binary.mkdir()
            for name in (
                "orch-heartbeat.sh",
                "heartbeat-decision.py",
                "heartbeat-board-observation.py",
                "heartbeat-run-observation.py",
                "notice_transport.py",
                "inbox_question_decision.py",
            ):
                shutil.copy2(PATH.with_name(name), hooks)
            record_id = "01990000-0000-7000-8000-000000000001"
            member_id = "01990000-0000-7000-8000-000000000002"
            started = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()
            watch_until = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
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
            failed = json.dumps(
                {
                    "record_id": record_id,
                    "number": 7,
                    "job": "fixture",
                    "agent": "codex",
                    "status": "failed",
                    "live_member_status": "failed",
                    "live_member_id": member_id,
                    "live_member_number": 8,
                    "failure_kind": "contract",
                    "latency_ms": 2000,
                    "started_at": started,
                    "automatic_failover_successor": None,
                    "automatic_failover_watch_until": watch_until,
                }
            )
            fake = binary / "bottega"
            fake.write_text(
                f'''#!/bin/sh
case "$*" in
  "board presence") exit 0 ;;
  "question inbox --all --active --json") printf '[]\\n' ;;
  "run list --live --json")
    tick=$(cat "$FAKE_TICK" 2>/dev/null || printf '0'); tick=$((tick + 1))
    printf '%s' "$tick" >"$FAKE_TICK"
    [ "$tick" = "2" ] || printf '%s\\n' '{live}' ;;
  "run list --json --id "*)
    printf '%s\\n' "$*" >>"$FAKE_COMPLETION_CALLS"
    tick=$(cat "$FAKE_TICK" 2>/dev/null || printf '0')
    if [ "$tick" = "2" ]; then printf '%s\\n' '{failed}'; else printf '%s\\n' '{live}'; fi ;;
  "machine monitor --notices --json"|"machine monitor --notices --json --skip-board-refresh") printf '[]\\n' ;;
  *) exit 1 ;;
esac
''',
                encoding="utf-8",
            )
            fake.chmod(0o755)
            calls = checkout / "completion-calls"
            environment = {
                **os.environ,
                "BOTTEGA_ORCHESTRATOR_DB": str(checkout / "absent.db"),
                "FAKE_TICK": str(checkout / "tick"),
                "FAKE_COMPLETION_CALLS": str(calls),
            }

            completed = self.run_shell_four_ticks(
                "the watched-failure fixture's four ticks",
                ["bash", str(hooks / "orch-heartbeat.sh"), "fixture-session", "0.01", "4"],
                cwd=checkout,
                env=environment,
                capture_output=True,
                text=True,
                check=True,
            )

            self.assertNotIn("DEGRADED", completed.stdout)
            self.assertEqual(
                completed.stdout.count(
                    "FAILED 8/fixture codex contract 2.0s; inspect with 'bottega run show 8'"
                ),
                1,
                completed.stdout,
            )
            self.assertNotIn("FAILOVER", completed.stdout)
            # The watch is spent on the tick that found the root live again: the
            # root is read once to report its failure and once to drop the watch,
            # and not on the final tick.
            self.assertEqual(
                calls.read_text(encoding="utf-8").splitlines(),
                [f"run list --json --id {record_id}", f"run list --json --id {record_id}"],
            )
    def run_failover_fixture(self, first_successor, later_successor=None, degraded_inbox_call=None):
        """Announce one failed chain, whose successor may exist at the first read or later.

        `degraded_inbox_call` fails the inbox read on that 1-based tick, which is
        the tick whose observation is discarded without being announced.
        """
        with tempfile.TemporaryDirectory() as root:
            checkout = Path(root)
            hooks = checkout / "orchestrator" / "hooks"
            binary = checkout / "bin"
            hooks.mkdir(parents=True)
            binary.mkdir()
            for name in (
                "orch-heartbeat.sh",
                "heartbeat-decision.py",
                "heartbeat-board-observation.py",
                "heartbeat-run-observation.py",
                "notice_transport.py",
                "inbox_question_decision.py",
            ):
                shutil.copy2(PATH.with_name(name), hooks)
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
            terminal = {
                "record_id": record_id,
                "number": 7,
                "job": "fixture",
                "agent": "codex",
                "status": "failed",
                "live_member_status": "failed",
                "live_member_id": member_id,
                "live_member_number": 8,
                "failure_kind": "contract",
                "latency_ms": 2000,
                "started_at": started,
            }
            # What the run listing publishes: the instant its successor stops
            # being worth waiting for while none has claimed a row yet, and
            # nothing once one has.
            watch_until = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()

            def completion_row(successor):
                return json.dumps(
                    {
                        **terminal,
                        "automatic_failover_successor": successor,
                        "automatic_failover_watch_until": None if successor else watch_until,
                    }
                )

            first = completion_row(first_successor)
            later = first if later_successor is None else completion_row(later_successor)
            fake = binary / "bottega"
            fake.write_text(
                f'''#!/bin/sh
case "$*" in
  "board presence") exit 0 ;;
  "question inbox --all --active --json")
    if [ -n "$FAKE_INBOX_FAIL_CALL" ]; then
      inbox_calls=$(cat "$FAKE_INBOX_CALLS" 2>/dev/null || printf '0')
      inbox_calls=$((inbox_calls + 1))
      printf '%s' "$inbox_calls" >"$FAKE_INBOX_CALLS"
      [ "$inbox_calls" != "$FAKE_INBOX_FAIL_CALL" ] || exit 1
    fi
    printf '[]\\n' ;;
  "run list --live --json")
    if [ -f "$FAKE_LIVE_SEEN" ]; then exit 0; else : >"$FAKE_LIVE_SEEN"; printf '%s\\n' '{live}'; fi ;;
  "run list --json --id {record_id}")
    if [ -f "$FAKE_TERMINAL_SEEN" ]; then printf '%s\\n' '{later}'
    else : >"$FAKE_TERMINAL_SEEN"; printf '%s\\n' '{first}'; fi ;;
  "machine monitor --notices --json"|"machine monitor --notices --json --skip-board-refresh") printf '[]\\n' ;;
  *) exit 1 ;;
esac
''',
                encoding="utf-8",
            )
            fake.chmod(0o755)
            environment = {
                **os.environ,
                "BOTTEGA_ORCHESTRATOR_DB": str(checkout / "absent.db"),
                "FAKE_LIVE_SEEN": str(checkout / "live-seen"),
                "FAKE_TERMINAL_SEEN": str(checkout / "terminal-seen"),
                "FAKE_INBOX_CALLS": str(checkout / "inbox-calls"),
                "FAKE_INBOX_FAIL_CALL": "" if degraded_inbox_call is None else str(degraded_inbox_call),
            }
            completed = self.run_shell_four_ticks(
                "the failover fixture's four ticks",
                ["bash", str(hooks / "orch-heartbeat.sh"), "fixture-session", "0.01", "4"],
                cwd=checkout,
                env=environment,
                capture_output=True,
                text=True,
                check=True,
            )
            return completed.stdout
    def test_a_chain_finishing_between_ticks_is_announced_once(self):
        self.assert_completion_announcement("ok", None, "FINISHED 8/fixture codex 2.0s")
    def test_a_chain_failing_between_ticks_is_announced_once(self):
        self.assert_completion_announcement(
            "failed", "contract", "FAILED 8/fixture codex contract 2.0s"
        )
    def test_a_capacity_failure_names_its_retry(self):
        self.assert_completion_announcement(
            "failed", "capacity", "FAILED 8/fixture codex capacity 2.0s; retry with 'bottega run retry 8'"
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
            shutil.copy2(PATH.with_name("heartbeat-board-observation.py"), hooks)
            shutil.copy2(PATH.with_name("heartbeat-run-observation.py"), hooks)
            shutil.copy2(PATH.with_name("notice_transport.py"), hooks)
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
  "machine monitor --notices --json"|"machine monitor --notices --json --skip-board-refresh") printf '[]\\n' ;;
  *) exit 1 ;;
esac
''',
                encoding="utf-8",
            )
            fake.chmod(0o755)

            completed = self.run_shell(
                "the completion fixture's three ticks",
                ["bash", str(hooks / "orch-heartbeat.sh"), "fixture-session", "0.01", "3"],
                cwd=checkout,
                env={
                    **os.environ,
                    "BOTTEGA_ORCHESTRATOR_DB": str(checkout / "absent.db"),
                    "FAKE_LIVE_SEEN": str(checkout / "live-seen"),
                },
                capture_output=True,
                text=True,
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
                "heartbeat-board-observation.py",
                "heartbeat-run-observation.py",
                "notice_transport.py",
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
  "machine monitor --notices --json"|"machine monitor --notices --json --skip-board-refresh") printf '[]\\n' ;;
  *) exit 1 ;;
esac
''',
                encoding="utf-8",
            )
            fake.chmod(0o755)
            env = {
                **os.environ,
                "BOTTEGA_ORCHESTRATOR_DB": str(checkout / "absent.db"),
                "FAKE_FIRST_LIVE": str(checkout / "first-live"),
                "FAKE_FIRST_MISSING": str(checkout / "first-missing"),
                "FAKE_SECOND_LIVE": str(checkout / "second-live"),
            }
            completed = self.run_shell_four_ticks(
                "the continued-chain fixture's four ticks",
                ["bash", str(hooks / "orch-heartbeat.sh"), "fixture-session", "0.01", "4"],
                cwd=checkout,
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )

            self.assertEqual(completed.stdout.count("FINISHED 8/fixture codex 2.0s"), 1)
            self.assertEqual(completed.stdout.count("FINISHED 9/fixture codex 2.0s"), 1)
    def test_relative_path_restart_carries_live_chain_into_completion(self):
        """The watch and the live chain both survive a heartbeat self-restart.

        The restart re-execs the hook with its carried state in the environment.
        Both the roots last seen live and the failures still awaiting a successor
        must cross it, or the failure the restarted hook rereads would be
        announced again and the successor that appears on the far side never
        named.
        """
        with tempfile.TemporaryDirectory() as root:
            checkout = Path(root)
            hooks = checkout / "orchestrator" / "hooks"
            binary = checkout / "bin"
            hooks.mkdir(parents=True)
            binary.mkdir()
            for name in (
                PATH.name,
                "orch-heartbeat.sh",
                "heartbeat-board-observation.py",
                "heartbeat-run-observation.py",
                "notice_transport.py",
                "inbox_question_decision.py",
            ):
                shutil.copy2(PATH.with_name(name), hooks)
            failed_root = "01990000-0000-7000-8000-000000000001"
            failed_member = "01990000-0000-7000-8000-000000000002"
            live_root = "01990000-0000-7000-8000-000000000003"
            live_member = "01990000-0000-7000-8000-000000000004"
            started = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()
            watch_until = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()

            def live_row(record_id, member_id, number):
                return json.dumps(
                    {
                        "record_id": record_id,
                        "number": number,
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

            def failed_row(successor, watch):
                return json.dumps(
                    {
                        "record_id": failed_root,
                        "number": 7,
                        "job": "fixture",
                        "agent": "codex",
                        "status": "failed",
                        "live_member_status": "failed",
                        "live_member_id": failed_member,
                        "live_member_number": 8,
                        "failure_kind": "contract",
                        "latency_ms": 2000,
                        "started_at": started,
                        "automatic_failover_successor": successor,
                        "automatic_failover_watch_until": watch,
                    }
                )

            def finished_row():
                return json.dumps(
                    {
                        "record_id": live_root,
                        "number": 9,
                        "job": "fixture",
                        "agent": "codex",
                        "status": "ok",
                        "live_member_status": "ok",
                        "live_member_id": live_member,
                        "live_member_number": 9,
                        "latency_ms": 2000,
                        "started_at": started,
                    }
                )

            fake = binary / "bottega"
            fake.write_text(
                f'''#!/bin/sh
case "$*" in
  "board presence") exit 0 ;;
  "question inbox --all --active --json") printf '[]\\n' ;;
  "run list --live --json")
    tick=$(cat "$FAKE_TICK" 2>/dev/null || printf '0'); tick=$((tick + 1))
    printf '%s' "$tick" >"$FAKE_TICK"
    case "$tick" in
      1) printf '%s\\n' '{live_row(failed_root, failed_member, 8)}' '{live_row(live_root, live_member, 9)}' ;;
      2) printf '%s\\n' '{live_row(live_root, live_member, 9)}' ;;
      *) : ;;
    esac ;;
  "run list --json --id "*)
    tick=$(cat "$FAKE_TICK" 2>/dev/null || printf '0')
    if [ "$tick" = "2" ]; then
      printf '%s\\n' '{failed_row(None, watch_until)}'
    else
      printf '%s\\n' '{failed_row({"number": 900, "agent": "grok"}, None)}' '{finished_row()}'
    fi ;;
  "machine monitor --notices --json"|"machine monitor --notices --json --skip-board-refresh")
    tick=$(cat "$FAKE_TICK" 2>/dev/null || printf '0')
    if [ "$tick" -ge 2 ] && [ ! -f "$FAKE_UPDATED" ]; then
      : >"$FAKE_UPDATED"; printf '\\n' >>"$FAKE_OBSERVATION_HELPER"
    fi
    printf '[]\\n' ;;
  *) exit 1 ;;
esac
''',
                encoding="utf-8",
            )
            fake.chmod(0o755)
            environment = {
                **os.environ,
                "BOTTEGA_ORCHESTRATOR_DB": str(checkout / "absent.db"),
                "FAKE_TICK": str(checkout / "tick"),
                "FAKE_UPDATED": str(checkout / "updated"),
                "FAKE_OBSERVATION_HELPER": str(hooks / "heartbeat-run-observation.py"),
            }

            completed = self.run_shell(
                "the restarted three-tick run",
                ["bash", "orchestrator/hooks/orch-heartbeat.sh", "fixture-session", "0.01", "3"],
                cwd=checkout,
                env=environment,
                capture_output=True,
                text=True,
                check=True,
            )

            self.assertEqual(completed.stdout.count("heartbeat updated on disk; restarting"), 1)
            self.assertEqual(
                completed.stdout.count("FAILED 8/fixture codex contract 2.0s; inspect with 'bottega run show 8'"),
                1,
                completed.stdout,
            )
            self.assertEqual(completed.stdout.count("FINISHED 9/fixture codex 2.0s"), 1, completed.stdout)
            self.assertEqual(
                completed.stdout.count(
                    "FAILOVER 8/fixture contract; automatic failover started run 900 on grok"
                ),
                1,
                completed.stdout,
            )
            self.assertNotIn("DEGRADED", completed.stdout)
    def test_shared_inbox_decision_imports_with_minimal_path_python(self):
        minimal_path = "/usr/bin:/bin"
        python = shutil.which("python3", path=minimal_path)
        self.assertIsNotNone(python, "minimal PATH has no system python3")
        self.run_helper(
            "the minimal-path inbox import",
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
            shutil.copy2(PATH.with_name("heartbeat-board-observation.py"), hooks)
            shutil.copy2(PATH.with_name("heartbeat-run-observation.py"), hooks)
            shutil.copy2(PATH.with_name("notice_transport.py"), hooks)
            fake = binary / "bottega"
            fake.write_text(
                """#!/bin/sh
case \"$*\" in
  \"board presence\") exit 0 ;;
  \"question inbox --all --active --json\") printf '[]\\n' ;;
  \"run list --live --json\") exit 0 ;;
  \"machine monitor --notices --json --skip-board-refresh\")
    printf '%s\\n' '[{\"noticeId\":\"condition:1\",\"kind\":\"worker-gate-tooling-change\",\"subject\":\"run:01990000-0000-7000-8000-000000000002\",\"label\":\"run 16709\",\"detail\":\"detected (age unknown, status ok, project bottega); inspect the run deliberately.\",\"ownerSession\":\"fixture-session\"}]' ;;
  \"machine monitor --ack-notices condition:1 --json\") exit 0 ;;
  *) exit 0 ;;
esac
""",
                encoding="utf-8",
            )
            fake.chmod(0o755)

            completed = self.run_shell(
                "the single tick run",
                ["bash", str(hooks / "orch-heartbeat.sh"), "fixture-session", "0.01", "1"],
                cwd=checkout,
                env={**os.environ, "BOTTEGA_ORCHESTRATOR_DB": str(checkout / "absent.db")},
                capture_output=True,
                text=True,
                check=True,
            )

            self.assertIn(
                "MONITOR worker-gate-tooling-change run 16709: detected (age unknown, status ok, project bottega); inspect the run deliberately.",
                completed.stdout.splitlines(),
            )
            self.assertNotIn("run:01990000", completed.stdout)
    def test_hosted_board_refresh_runs_separately_every_fifth_tick(self):
        with tempfile.TemporaryDirectory() as root:
            checkout = Path(root)
            hooks = checkout / "orchestrator" / "hooks"
            binary = checkout / "bin"
            hooks.mkdir(parents=True)
            binary.mkdir()
            shutil.copy2(PATH, hooks / PATH.name)
            shutil.copy2(PATH.with_name("inbox_question_decision.py"), hooks)
            shutil.copy2(PATH.with_name("orch-heartbeat.sh"), hooks / "orch-heartbeat.sh")
            shutil.copy2(PATH.with_name("heartbeat-board-observation.py"), hooks)
            shutil.copy2(PATH.with_name("heartbeat-run-observation.py"), hooks)
            shutil.copy2(PATH.with_name("notice_transport.py"), hooks)
            calls = checkout / "monitor-calls"
            fake = binary / "bottega"
            fake.write_text(
                """#!/bin/sh
case \"$*\" in
  \"board presence\") exit 0 ;;
  \"question inbox --all --active --json\") printf '[]\\n' ;;
  \"run list --live --json\")
    printf '%s\\n' '{\"record_id\":\"01990000-0000-7000-8000-000000000001\",\"number\":1,\"job\":\"fixture\",\"agent\":\"codex\",\"status\":\"running\",\"live_statuses\":[\"queued\",\"reserved\",\"attached\",\"running\",\"asking\"],\"session_id\":\"fixture-session\",\"started_at\":\"2026-01-01T00:00:00Z\",\"latency_ms\":null,\"live_member_id\":\"01990000-0000-7000-8000-000000000001\",\"live_member_number\":1,\"live_member_status\":\"running\",\"stall_state\":\"healthy\",\"waiting_for_host_capacity\":false,\"host_wait_since\":null,\"stall\":null,\"turns\":[{\"started_at\":\"2026-01-01T00:00:00Z\",\"latency_ms\":null}]}' ;;
  \"machine monitor --notices --json\"|\"machine monitor --notices --json --skip-board-refresh\")
    printf '%s\\n' \"$*\" >>\"$FAKE_MONITOR_CALLS\"
    printf '%s\\n' '{\"notices\":[],\"warning\":null}' ;;
  *) exit 0 ;;
esac
""",
                encoding="utf-8",
            )
            fake.chmod(0o755)

            self.run_shell(
                "the five-tick monitor refresh run",
                ["bash", str(hooks / "orch-heartbeat.sh"), "fixture-session", "0.01", "5"],
                cwd=checkout,
                env={
                    **os.environ,
                    "BOTTEGA_ORCHESTRATOR_DB": str(checkout / "absent.db"),
                    "FAKE_MONITOR_CALLS": str(calls),
                },
                capture_output=True,
                text=True,
                check=True,
            )

            self.assertEqual(
                calls.read_text(encoding="utf-8").splitlines(),
                [
                    "machine monitor --notices --json --skip-board-refresh",
                    "machine monitor --notices --json --skip-board-refresh",
                    "machine monitor --notices --json --skip-board-refresh",
                    "machine monitor --notices --json --skip-board-refresh",
                    "machine monitor --notices --json",
                ],
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
                shutil.copy2(PATH.with_name("heartbeat-board-observation.py"), hooks)
                shutil.copy2(PATH.with_name("heartbeat-run-observation.py"), hooks)
                shutil.copy2(PATH.with_name("notice_transport.py"), hooks)
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
  \"machine monitor --notices --json --skip-board-refresh\") echo $$ >\"$FAKE_MONITOR_PID_FILE\"; sleep 30 ;;
  *) exit 0 ;;
esac
""",
                    encoding="utf-8",
                )
                fake.chmod(0o755)
                environment = {
                    **os.environ,
                    "BOTTEGA_ORCHESTRATOR_DB": str(checkout / "absent.db"),
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
                    self.wait_until(
                        "the guarded monitor and the watchdog to start",
                        REAP_START_GUARD_SECONDS,
                        lambda: monitor_pid_file.exists() and watchdog_pid_file.exists(),
                    )
                    monitor_pid = int(monitor_pid_file.read_text(encoding="utf-8"))
                    watchdog_pid = int(watchdog_pid_file.read_text(encoding="utf-8"))

                    heartbeat.send_signal(sent_signal)
                    self.wait_for_child(
                        "the signaled heartbeat to leave",
                        REAP_EXIT_GUARD_SECONDS,
                        heartbeat,
                    )
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
