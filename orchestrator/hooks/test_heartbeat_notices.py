"""The heartbeat delivers every notice it can transport and reports what the acknowledgement refuses."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


HOOKS = Path(__file__).parent
CHILD_PROCESS_TIMEOUT_SECONDS = 10
SESSION = "fixture-session"
CONDITION_ID = "condition:1"
LANDING_ID = "01990000-0000-7000-8000-000000000002"
BOARD_ID = "01990000-0000-7000-8000-000000000003"

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
    directory = Path(tempfile.mkdtemp(prefix="heartbeat-notice-temp-"))
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
    os.environ["PATH"] = _SHELL_TEMP["path"]
    if _SHELL_TEMP["mktemp_dir"] is None:
        os.environ.pop("MKTEMP_DIR", None)
    else:
        os.environ["MKTEMP_DIR"] = _SHELL_TEMP["mktemp_dir"]
    shutil.rmtree(_SHELL_TEMP["directory"], ignore_errors=True)
    _SHELL_TEMP.clear()


def notice(notice_id, kind, label, detail):
    return {
        "noticeId": notice_id,
        "kind": kind,
        "subject": "run:" + LANDING_ID,
        "label": label,
        "detail": detail,
        "ownerSession": SESSION,
    }


def run_heartbeat(rows, ack_result=""):
    """Run one tick over `rows` and report the lines it emitted and the ids it acknowledged."""
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
"heartbeat-decision.py",
            "heartbeat-run-observation.py",
            "inbox_question_decision.py",
            "notice_transport.py",
        ):
            shutil.copy2(HOOKS / name, hooks / name)
        notices = checkout / "notices.json"
        notices.write_text(json.dumps(rows), encoding="utf-8")
        ack_log = checkout / "acked.txt"
        ack_log.write_text("", encoding="utf-8")
        fake = binary / "bottega"
        fake.write_text(
            """#!/bin/sh
case "$*" in
  "machine monitor --notices --json"|"machine monitor --notices --json --skip-board-refresh")
    cat "$FIXTURE_NOTICES" ;;
  "machine monitor --ack-notices "*)
    printf '%s\\n' "$*" >>"$FIXTURE_ACK_LOG"
    if [ -n "$FIXTURE_ACK_RESULT" ]; then printf '%s\\n' "$FIXTURE_ACK_RESULT"; fi ;;
  "question inbox --all --active --json") printf '[]\\n' ;;
  *) exit 0 ;;
esac
""",
            encoding="utf-8",
        )
        fake.chmod(0o755)

        completed = subprocess.run(
            ["bash", str(hooks / "orch-heartbeat.sh"), SESSION, "0.01", "1"],
            cwd=checkout,
            env={
                **os.environ,
                "BOTTEGA_ORCHESTRATOR_DB": str(checkout / "absent.db"),
                "FIXTURE_NOTICES": str(notices),
                "FIXTURE_ACK_LOG": str(ack_log),
                "FIXTURE_ACK_RESULT": ack_result,
            },
            capture_output=True,
            text=True,
            timeout=CHILD_PROCESS_TIMEOUT_SECONDS,
            check=True,
        )
        acked = [line for line in ack_log.read_text(encoding="utf-8").splitlines() if line]
        return completed.stdout.splitlines(), acked


class HeartbeatNoticeTest(unittest.TestCase):
    def test_condition_landing_and_board_notices_are_delivered_and_acknowledged(self):
        condition_detail = (
            "detected (age unknown, status ok, project fixture); inspect the run deliberately."
        )
        landing_detail = f"LANDING-REFUSED {LANDING_ID}/fixture-branch 1.0s; inspect with 'tree branch'"
        board_detail = "a reply is waiting on the board notice"
        rows = [
            notice(CONDITION_ID, "worker-gate-tooling-change", "run 16709", condition_detail),
            notice(
                f"landing:{LANDING_ID}",
                "landing-refused",
                f"landing:{LANDING_ID}",
                landing_detail,
            ),
            notice(f"board:{BOARD_ID}", "board-notice", f"board:{BOARD_ID}", board_detail),
        ]

        lines, acked = run_heartbeat(rows)

        self.assertEqual(
            acked,
            [
                "machine monitor --ack-notices "
                + f"{CONDITION_ID},landing:{LANDING_ID},board:{BOARD_ID} --json"
            ],
        )
        self.assertIn(f"MONITOR worker-gate-tooling-change run 16709: {condition_detail}", lines)
        self.assertIn(landing_detail, lines)
        self.assertIn(f"MONITOR board-notice board:{BOARD_ID}: {board_detail}", lines)
        self.assertNotIn("DEGRADED", "\n".join(lines))

    def test_the_parser_passes_ids_through_and_refuses_only_what_it_cannot_transport(self):
        condition_detail = (
            "detected (age unknown, status ok, project fixture); inspect the run deliberately."
        )
        board_detail = "a reply is waiting on the board notice"
        rows = [
            notice(CONDITION_ID, "worker-gate-tooling-change", "run 16709", condition_detail),
            notice("landing:7", "landing-refused", "landing:7", "grammar's business detail"),
            notice("other:7", "board-notice", "board:7", "unknown source detail"),
            notice("board:\u00007", "board-notice", "board:7", "NUL detail"),
            {
                "kind": "board-notice",
                "subject": "board:8",
                "label": "board:8",
                "detail": "unnamed detail",
                "ownerSession": SESSION,
            },
        ]

        lines, acked = run_heartbeat(rows)

        # The grammar is the acknowledgement's to judge: only the id that cannot
        # survive the row protocol is refused here.
        self.assertEqual(
            acked,
            [f"machine monitor --ack-notices {CONDITION_ID},landing:7,other:7 --json"],
        )
        emitted = "\n".join(lines)
        self.assertNotIn("board:7", acked[0])
        for delivered in (
            f"MONITOR worker-gate-tooling-change run 16709: {condition_detail}",
            "grammar's business detail",
            "MONITOR board-notice board:7: unknown source detail",
        ):
            self.assertIn(delivered, lines)
        degraded = [line for line in lines if "DEGRADED" in line]
        self.assertEqual(len(degraded), 1, lines)
        self.assertIn("monitor notices refused 2 notice(s) and delivered the rest of the batch", degraded[0])
        self.assertIn("board: 7 (notice id cannot be transported unchanged)", degraded[0])
        self.assertIn("#5 (notice id is missing or not a string)", degraded[0])
        for refused in ("NUL detail", "unnamed detail"):
            self.assertNotIn(refused, emitted)

    def test_an_empty_notice_id_is_named_and_the_rest_of_its_batch_is_delivered(self):
        condition_detail = (
            "detected (age unknown, status ok, project fixture); inspect the run deliberately."
        )
        rows = [
            notice(CONDITION_ID, "worker-gate-tooling-change", "run 16709", condition_detail),
            notice("", "board-notice", "board:7", "empty id detail"),
        ]

        lines, acked = run_heartbeat(rows)

        # The empty id cannot be carried into the comma-joined list at all, so it is
        # named and skipped while the notice beside it still goes out.
        self.assertEqual(acked, [f"machine monitor --ack-notices {CONDITION_ID} --json"])
        self.assertIn(f"MONITOR worker-gate-tooling-change run 16709: {condition_detail}", lines)
        degraded = [line for line in lines if "DEGRADED" in line]
        self.assertEqual(len(degraded), 1, lines)
        self.assertIn(
            "monitor notices refused 1 notice(s) and delivered the rest of the batch", degraded[0]
        )
        self.assertIn("(empty notice id) (notice id cannot be transported unchanged)", degraded[0])
        self.assertNotIn("empty id detail", "\n".join(lines))

    def test_a_batch_refused_whole_says_that_nothing_was_delivered(self):
        rows = [notice("board:\u00007", "board-notice", "board:7", "NUL detail")]

        lines, acked = run_heartbeat(rows)

        self.assertEqual(acked, [])
        degraded = [line for line in lines if "DEGRADED" in line]
        self.assertEqual(len(degraded), 1, lines)
        self.assertIn("refused 1 notice(s) and delivered nothing from this batch", degraded[0])
        self.assertIn("board: 7 (notice id cannot be transported unchanged)", degraded[0])
        self.assertNotIn("NUL detail", "\n".join(lines))

    def test_the_acknowledgements_refusals_are_reported_beside_the_rest_of_the_batch(self):
        condition_detail = (
            "detected (age unknown, status ok, project fixture); inspect the run deliberately."
        )
        refusal = json.dumps(
            {
                "acknowledged": [CONDITION_ID],
                "refused": [
                    {
                        "id": "other:7",
                        "reason": (
                            "a notice id is <source>:<identifier> "
                            "with source condition, landing or board"
                        ),
                    }
                ],
            }
        )
        rows = [
            notice(CONDITION_ID, "worker-gate-tooling-change", "run 16709", condition_detail),
            notice("other:7", "board-notice", "board:7", "unknown source detail"),
        ]

        lines, acked = run_heartbeat(rows, ack_result=refusal)

        self.assertEqual(
            acked,
            [f"machine monitor --ack-notices {CONDITION_ID},other:7 --json"],
        )
        self.assertIn(f"MONITOR worker-gate-tooling-change run 16709: {condition_detail}", lines)
        self.assertIn("MONITOR board-notice board:7: unknown source detail", lines)
        degraded = [line for line in lines if "DEGRADED" in line]
        self.assertEqual(len(degraded), 1, lines)
        self.assertIn("the acknowledgement refused 1 of the 2 id(s) in this batch", degraded[0])
        self.assertIn("other:7 (a notice id is <source>:<identifier>", degraded[0])
        self.assertIn("a refused id stays undelivered and repeats", degraded[0].lower())


if __name__ == "__main__":
    unittest.main()
