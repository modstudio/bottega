import importlib.util
import unittest
from pathlib import Path


PATH = Path(__file__).with_name("score_reminder_decision.py")
SPEC = importlib.util.spec_from_file_location("score_reminder_decision", PATH)
score_reminder_decision = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(score_reminder_decision)

HeldTreeFacts = score_reminder_decision.HeldTreeFacts
decide_held_tree = score_reminder_decision.decide_held_tree
parse_held_run_report = score_reminder_decision.parse_held_run_report


class HeldTreeDecisionTest(unittest.TestCase):
    def test_in_flight_for_this_tree_is_listed_not_blocking(self):
        decision = decide_held_tree(HeldTreeFacts("/landing-tree", "cursor 459 merge-pr"))
        self.assertFalse(decision.block)
        self.assertEqual(
            decision.in_flight_line,
            "in flight: /landing-tree (cursor 459 merge-pr)",
        )

    def test_open_pr_without_cursor_is_listed_not_blocking(self):
        decision = decide_held_tree(HeldTreeFacts("/landing-tree", "#88"))
        self.assertFalse(decision.block)
        self.assertEqual(decision.in_flight_line, "in flight: /landing-tree (#88)")

    def test_neither_cursor_nor_pr_blocks(self):
        decision = decide_held_tree(HeldTreeFacts("/landing-tree", None))
        self.assertTrue(decision.block)
        self.assertIsNone(decision.in_flight_line)

    def test_dirty_unique_work_hold_blocks(self):
        parsed = parse_held_run_report(
            "held run abc-1 /tmp/orch-tree: landing tree held by session owner: tree is dirty; "
            "in flight (cursor 459 merge-pr)"
        )
        self.assertEqual(parsed, HeldTreeFacts("/tmp/orch-tree", None))
        decision = decide_held_tree(parsed)
        self.assertTrue(decision.block)
        self.assertIsNone(decision.in_flight_line)

    def test_parse_held_run_report_reads_in_flight_prefix(self):
        self.assertEqual(
            parse_held_run_report(
                "held run abc-1 /tmp/orch-tree: in flight (cursor 459 merge-pr); "
                "landing tree held by session owner: landing is in flight"
            ),
            HeldTreeFacts("/tmp/orch-tree", "cursor 459 merge-pr"),
        )
        self.assertEqual(
            parse_held_run_report(
                "held run abc-1 /tmp/orch-tree: landing tree held by session owner: tree is dirty"
            ),
            HeldTreeFacts("/tmp/orch-tree", None),
        )
        self.assertIsNone(parse_held_run_report("kept run abc-1 /tmp/orch-tree: clean"))


if __name__ == "__main__":
    unittest.main()
