import importlib.util
import sys
import unittest
from pathlib import Path


PATH = Path(__file__).with_name("heartbeat-decision.py")
sys.path.insert(0, str(PATH.parent))
SPEC = importlib.util.spec_from_file_location("heartbeat_decision_open_requests", PATH)
heartbeat_decision = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(heartbeat_decision)

SESSION = "asking-session"
NOW = 1_800_000_000


def root(**changes):
    return {
        "id": "request-1",
        "label": "board:12 Need a ruling",
        "kind": "notice",
        "purpose": "request",
        "author_session": SESSION,
        "expires_at": "2027-01-15T09:00:00.000Z",
        "withdrawn_at": None,
        "task_keys": [],
        **changes,
    }


class OpenBoardRequestsTest(unittest.TestCase):
    def decide(self, roots, replies=(), task_done=lambda _key: None):
        return heartbeat_decision.open_board_requests(
            roots, list(replies), SESSION, NOW, task_done
        )

    def test_open_request_without_reply_holds_the_watch(self):
        self.assertEqual(self.decide([root()]), [root()])

    def test_request_authored_by_another_session_does_not_hold_the_watch(self):
        self.assertEqual(self.decide([root(author_session="another-session")]), [])

    def test_reply_delivered_to_the_author_releases_the_watch(self):
        reply = {
            "root_id": "request-1",
            "author_session": "answering-session",
            "delivered_at": "2027-01-15T08:00:00.000Z",
        }
        self.assertEqual(self.decide([root()], [reply]), [])

    def test_expired_root_releases_the_watch(self):
        self.assertEqual(self.decide([root(expires_at="2026-01-15T09:00:00.000Z")]), [])

    def test_withdrawn_root_releases_the_watch(self):
        self.assertEqual(
            self.decide([root(withdrawn_at="2027-01-15T08:00:00.000Z")]), []
        )

    def test_root_with_all_tagged_tasks_done_releases_the_watch(self):
        self.assertEqual(
            self.decide([root(task_keys=["DEV-1", "DEV-2"])], task_done=lambda _key: True),
            [],
        )

    def test_one_done_and_one_open_task_keeps_the_watch(self):
        self.assertEqual(
            self.decide(
                [root(task_keys=["DEV-1", "DEV-2"])],
                task_done=lambda key: key == "DEV-1",
            ),
            [root(task_keys=["DEV-1", "DEV-2"])],
        )

    def test_unknown_task_status_keeps_the_watch(self):
        self.assertEqual(
            self.decide([root(task_keys=["DEV-1"])], task_done=lambda _key: None),
            [root(task_keys=["DEV-1"])],
        )

    def test_non_string_task_key_keeps_watch_without_calling_resolver(self):
        calls = []
        tagged_root = root(task_keys=["DEV-1", 42])
        self.assertEqual(
            self.decide(
                [tagged_root],
                task_done=lambda key: calls.append(key) or True,
            ),
            [tagged_root],
        )
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
