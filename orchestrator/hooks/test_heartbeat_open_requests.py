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
        "expires_at": "2027-01-15T09:00:00.000Z",
        "withdrawn_at": None,
        **changes,
    }


class OpenBoardRequestsTest(unittest.TestCase):
    def decide(self, roots, replies=()):
        return heartbeat_decision.open_board_requests(roots, list(replies), SESSION, NOW)

    def test_no_request_is_clear(self):
        self.assertEqual(self.decide([]), [])

    def test_open_request_without_reply_holds_the_watch(self):
        self.assertEqual(self.decide([root()]), [root()])

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


if __name__ == "__main__":
    unittest.main()
