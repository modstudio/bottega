import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


PATH = Path(__file__).with_name("score_reminder_decision.py")
SPEC = importlib.util.spec_from_file_location("score_reminder_decision", PATH)
score_reminder_decision = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(score_reminder_decision)

decide_held_tree = score_reminder_decision.decide_held_tree
decide_stop = score_reminder_decision.decide_stop
refusal_score_guidance = score_reminder_decision.refusal_score_guidance
unscored_remedy = score_reminder_decision.unscored_remedy
WRITING_JOBS = score_reminder_decision.WRITING_JOBS
REQUIRED_REPLY_KEYS = score_reminder_decision.REQUIRED_REPLY_KEYS
REPLY_STATUSES = score_reminder_decision.REPLY_STATUSES
FIXTURE = PATH.parents[1] / "src" / "close" / "held-tree-json.fixture.json"
REFUSAL_FIXTURE = PATH.parents[1] / "src" / "score" / "refusal-guidance.fixture.json"


class UnscoredRemedyTest(unittest.TestCase):
    def test_ok_uses_axes(self):
        self.assertEqual(unscored_remedy("ok", None, "codex"), "axes")

    def test_interrupted_failure_is_void(self):
        self.assertEqual(unscored_remedy("failed", "interrupted", "codex"), "void")

    def test_unevidenced_failure_is_void(self):
        self.assertEqual(unscored_remedy("failed", "unevidenced", "codex"), "void")

    def test_pending_agent_stopped_failure_is_void(self):
        self.assertEqual(unscored_remedy("stopped", "stopped", "(pending)"), "void")

    def test_resolved_agent_stopped_failure_uses_none(self):
        self.assertEqual(unscored_remedy("stopped", "stopped", "codex"), "none")

    def test_contract_failure_uses_none(self):
        self.assertEqual(unscored_remedy("failed", "contract", "codex"), "none")


class HeldTreeDecisionTest(unittest.TestCase):
    def test_fixture_shape_feeds_the_decision(self):
        rows = json.loads(FIXTURE.read_text())
        in_flight, unique_work, other, hook_tree = rows
        listed = decide_held_tree(in_flight)
        self.assertFalse(listed.block)
        self.assertEqual(
            listed.in_flight_line,
            f"in flight: {in_flight['worktree']} ({in_flight['inFlightRef']})",
        )
        self.assertTrue(decide_held_tree(unique_work).block)
        self.assertTrue(decide_held_tree(other).block)
        kept = decide_held_tree(hook_tree)
        self.assertFalse(kept.block)
        self.assertEqual(
            kept.in_flight_line,
            f"in flight: {hook_tree['worktree']} ({hook_tree['inFlightRef']})",
        )


class StopDecisionTest(unittest.TestCase):
    NOTES = [
        ("workshop#12", "first note", "starship"),
        ("starship#34", "second note", "starship"),
    ]

    def test_notes_only_are_informational_and_marked_seen(self):
        decision = decide_stop(0, 0, 0, self.NOTES, set())
        self.assertFalse(decision.block)
        self.assertEqual(len(decision.note_lines), 3)
        self.assertEqual(
            decision.note_lines[0],
            "2 notes filed in this session; hand each to its project's architects:",
        )
        self.assertIn("workshop#12  first note", decision.note_lines[1])
        self.assertIn("architects:starship", decision.note_lines[1])
        self.assertIn("starship#34  second note", decision.note_lines[2])
        self.assertEqual(decision.seen, ["starship#34", "workshop#12"])

    def test_notes_only_already_seen_do_not_repeat(self):
        decision = decide_stop(0, 0, 0, self.NOTES, {"starship#34", "workshop#12"})
        self.assertFalse(decision.block)
        self.assertEqual(decision.note_lines, [])

    def test_blocking_without_notes_blocks(self):
        self.assertTrue(decide_stop(1, 0, 0, [], set()).block)

    def test_blocking_with_unseen_note_includes_the_note(self):
        decision = decide_stop(1, 0, 0, [self.NOTES[0]], set())
        self.assertTrue(decision.block)
        self.assertIn("workshop#12  first note", decision.note_lines[1])

    def test_unknown_seen_state_prints_every_note(self):
        decision = decide_stop(0, 0, 0, self.NOTES, None)
        self.assertEqual(len(decision.note_lines), 3)
        self.assertEqual(decision.seen, ["starship#34", "workshop#12"])

    def test_note_lines_offer_no_triage_commands(self):
        decision = decide_stop(0, 0, 0, self.NOTES, set())
        for line in decision.note_lines:
            self.assertNotIn("note keep", line)
            self.assertNotIn("note drop", line)
            self.assertNotIn("note promote", line)


class RefusalScoreGuidanceTest(unittest.TestCase):
    def setUp(self):
        self.fixture = json.loads(REFUSAL_FIXTURE.read_text())

    def guidance(self, reply, job_name):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reply.txt"
            path.write_text(json.dumps(reply))
            return refusal_score_guidance(str(path), job_name)

    def test_shared_fixture_pins_worker_reply_vocabulary(self):
        self.assertEqual(REQUIRED_REPLY_KEYS, set(self.fixture["workerReplyRequired"]))
        self.assertEqual(REPLY_STATUSES, set(self.fixture["workerReplyStatuses"]))

    def test_shared_fixture_pins_guidance_and_writing_jobs(self):
        self.assertEqual(WRITING_JOBS, set(self.fixture["writingJobs"]))
        short = self.fixture["replies"]["shortRefused"]
        self.assertEqual(self.guidance(short, "implement"), self.fixture["expected"]["writing"])
        self.assertEqual(self.guidance(short, "craft"), self.fixture["expected"]["nonWriting"])

    def test_refusal_caps_a_long_one_line_summary_at_its_last_word_boundary(self):
        self.assertEqual(
            self.guidance(self.fixture["replies"]["longRefused"], "craft"),
            self.fixture["expected"]["longNonWriting"],
        )

    def test_newest_reply_decides_not_an_earlier_reply_shaped_object(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reply.txt"
            path.write_text(self.fixture["texts"]["narratedThenRefused"])
            self.assertEqual(
                refusal_score_guidance(str(path), "implement"),
                self.fixture["expected"]["writing"],
            )

    def test_done_absent_and_unreadable_replies_have_no_mark(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reply.txt"
            path.write_text(json.dumps(self.fixture["replies"]["done"]))
            self.assertIsNone(refusal_score_guidance(str(path), "craft"))
            self.assertIsNone(refusal_score_guidance(str(path) + ".missing", "craft"))
            path.write_bytes(b'{"status":"refused","summary":"bad \xff byte"}')
            self.assertIsNone(refusal_score_guidance(str(path), "craft"))


if __name__ == "__main__":
    unittest.main()
