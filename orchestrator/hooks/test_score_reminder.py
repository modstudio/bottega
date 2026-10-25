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
refusal_score_guidance = score_reminder_decision.refusal_score_guidance
FIXTURE = PATH.parents[1] / "src" / "close" / "held-tree-json.fixture.json"


class HeldTreeDecisionTest(unittest.TestCase):
    def test_fixture_shape_feeds_the_decision(self):
        rows = json.loads(FIXTURE.read_text())
        in_flight, unique_work, other = rows
        listed = decide_held_tree(in_flight)
        self.assertFalse(listed.block)
        self.assertEqual(
            listed.in_flight_line,
            f"in flight: {in_flight['worktree']} ({in_flight['inFlightRef']})",
        )
        self.assertTrue(decide_held_tree(unique_work).block)
        self.assertTrue(decide_held_tree(other).block)


class RefusalScoreGuidanceTest(unittest.TestCase):
    @staticmethod
    def reply(status, summary):
        return {
            "status": status,
            "summary": summary,
            "files_changed": None,
            "change_guide": None,
            "questions": None,
            "deviations": None,
            "blockers": None,
            "tests": None,
        }

    def test_refusal_quotes_first_summary_line_and_marks_writing_fidelity(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reply.txt"
            path.write_text(json.dumps(self.reply("refused", "evidence at a.ts:2\nmore")))
            guidance = refusal_score_guidance(str(path), True)
        self.assertIn('refused: "evidence at a.ts:2"', guidance)
        self.assertIn("correct with evidence: full right faithful", guidance)

    def test_done_and_absent_replies_have_no_mark(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reply.txt"
            path.write_text(json.dumps(self.reply("done", "complete")))
            self.assertIsNone(refusal_score_guidance(str(path), False))
            self.assertIsNone(refusal_score_guidance(str(path) + ".missing", False))


if __name__ == "__main__":
    unittest.main()
