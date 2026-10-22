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


def tree(
    *,
    path="/landing-tree",
    branch="DEV-1594-ship",
    cursor_id=None,
    cursor_step=None,
    cursor_workflow=None,
    cursor_live=False,
    open_pr=None,
):
    return HeldTreeFacts(
        path=path,
        branch=branch,
        cursor_id=cursor_id,
        cursor_step=cursor_step,
        cursor_workflow=cursor_workflow,
        cursor_live=cursor_live,
        open_pr=open_pr,
    )


class HeldTreeDecisionTest(unittest.TestCase):
    def test_live_merge_pr_cursor_is_listed_not_blocking(self):
        decision = decide_held_tree(
            tree(
                cursor_id=459,
                cursor_step="merge-pr",
                cursor_workflow="ship-task",
                cursor_live=True,
            ),
            False,
        )
        self.assertFalse(decision.block)
        self.assertEqual(
            decision.in_flight_line,
            "in flight: /landing-tree (cursor 459 merge-pr)",
        )

    def test_open_pr_without_cursor_is_listed_not_blocking(self):
        decision = decide_held_tree(tree(open_pr="#88"), False)
        self.assertFalse(decision.block)
        self.assertEqual(decision.in_flight_line, "in flight: /landing-tree (#88)")

    def test_neither_cursor_nor_pr_blocks(self):
        decision = decide_held_tree(tree(), False)
        self.assertTrue(decision.block)
        self.assertIsNone(decision.in_flight_line)

    def test_close_out_blocks_every_held_tree(self):
        in_flight = [
            tree(
                cursor_id=459,
                cursor_step="merge-pr",
                cursor_workflow="ship-task",
                cursor_live=True,
            ),
            tree(open_pr="#88"),
            tree(),
        ]
        for facts in in_flight:
            decision = decide_held_tree(facts, True)
            self.assertTrue(decision.block, facts)
            self.assertIsNone(decision.in_flight_line, facts)

    def test_finish_ship_cleanup_cursor_without_pr_blocks(self):
        decision = decide_held_tree(
            tree(
                cursor_id=12,
                cursor_step="finish-ship-cleanup",
                cursor_workflow="ship-task",
                cursor_live=True,
            ),
            False,
        )
        self.assertTrue(decision.block)

    def test_parse_held_run_report_reads_id_and_path(self):
        self.assertEqual(
            parse_held_run_report(
                "held run abc-1 /tmp/orch-tree: landing tree held by session owner: tree is dirty"
            ),
            ("abc-1", "/tmp/orch-tree"),
        )
        self.assertIsNone(parse_held_run_report("kept run abc-1 /tmp/orch-tree: clean"))


if __name__ == "__main__":
    unittest.main()
