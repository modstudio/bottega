"""The heartbeat decision's pure cases: values in, values out, nothing spawned.

Every case here calls the decision module directly and can fail for a subtle
defect in it, so they stay in the local gate. The cases that drive the heartbeat
shell, its helper children and its signals live beside them in
`process_heartbeat_shell.py`, which the gate's `test_*.py` discovery does not
pick up.
"""

import json
import unittest

from heartbeat_decision_fixture import PATH, heartbeat_decision


class HeartbeatDecisionTest(unittest.TestCase):
    """What the heartbeat decides from the counts and rows it has gathered."""

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
    def test_unreleased_live_hold_keeps_looping(self):
        decision = heartbeat_decision.heartbeat_decision(
            "12:34:56", [], 0, 0, 0, "", "", open_hold_count=1,
            open_hold_detail="board:held Load gate: busy",
        )
        self.assertFalse(decision.should_exit)
        self.assertIn("1 board hold(s)", decision.lines[0])
        self.assertIn("board:held Load gate: busy", decision.lines[0])
    def test_hold_resolution_releases_terminal_messages_and_superseded_prefix(self):
        roots = [self.root()]
        for field, reason in (("withdrawn_at", "withdrawn"), ("expires_at", "expired")):
            with self.subTest(reason=reason):
                changed = {**roots[0], field: "2026-10-30T00:30:00.000Z"}
                open_holds, releases = heartbeat_decision.resolve_board_holds(
                    [changed], [], [self.hold()], self.now,
                )
                self.assertEqual(open_holds, [])
                self.assertEqual(releases[0].reason, reason)
        successor = self.root(
            id="new", title="Load gate: open", created_at="2026-10-30T02:00:00.000Z"
        )
        open_holds, releases = heartbeat_decision.resolve_board_holds(
            roots + [successor], [], [self.hold()], self.now,
        )
        self.assertEqual(open_holds, [])
        self.assertEqual(releases[0].reason, "superseded by Load gate: open")
        self.assertEqual(releases[0].superseding_id, "new")
    def test_different_author_does_not_supersede_and_holder_reply_does_not_resolve(self):
        successor = self.root(
            id="new", author_session="other", title="Load gate: open",
            created_at="2026-10-30T02:00:00.000Z",
        )
        self_reply = {
            "root_id": "held", "author_session": "holder",
            "created_at": "2026-10-30T02:00:00.000Z",
        }
        open_holds, releases = heartbeat_decision.resolve_board_holds(
            [self.root(), successor], [self_reply], [self.hold()], self.now,
        )
        self.assertEqual(open_holds, [self.hold()])
        self.assertEqual(releases, [])
    def test_later_reply_from_another_session_releases_the_hold(self):
        reply = {
            "root_id": "held", "author_session": "answerer",
            "created_at": "2026-10-30T02:00:00.000Z",
        }
        open_holds, releases = heartbeat_decision.resolve_board_holds(
            [self.root()], [reply], [self.hold()], self.now,
        )
        self.assertEqual(open_holds, [])
        self.assertEqual(releases[0].reason, "replied")
    def test_hold_absent_from_observed_roots_releases(self):
        open_holds, releases = heartbeat_decision.resolve_board_holds(
            [], [], [self.hold()], self.now,
        )
        self.assertEqual(open_holds, [])
        self.assertEqual(releases[0].reason, "no longer on the board")
    now = heartbeat_decision._timestamp("2026-10-30T03:00:00.000Z")
    @staticmethod
    def root(**overrides):
        root = {
            "id": "held", "title": "Load gate: busy", "author_session": "author",
            "created_at": "2026-10-30T00:00:00.000Z",
            "expires_at": "2026-10-31T00:00:00.000Z", "withdrawn_at": None,
        }
        root.update(overrides)
        return root
    @staticmethod
    def hold():
        return {
            "message_id": "held", "session_id": "holder",
            "created_at": "2026-10-30T01:00:00.000Z", "title": "Load gate: busy",
        }
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
        self.assertFalse(decision.should_exit)
        self.assertIn("WAITING", decision.lines[0])
        self.assertIn("1 parked workflow ruling(s)", decision.lines[0])
        self.assertNotIn("BLOCKED", decision.lines[0])
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


if __name__ == "__main__":
    unittest.main()
