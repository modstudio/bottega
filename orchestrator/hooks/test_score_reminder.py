import importlib.util
import json
import unittest
from pathlib import Path


PATH = Path(__file__).with_name("score_reminder_decision.py")
SPEC = importlib.util.spec_from_file_location("score_reminder_decision", PATH)
score_reminder_decision = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(score_reminder_decision)

decide_held_tree = score_reminder_decision.decide_held_tree
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


if __name__ == "__main__":
    unittest.main()
