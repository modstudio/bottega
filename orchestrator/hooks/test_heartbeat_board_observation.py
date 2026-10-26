import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path


HOOKS = Path(__file__).parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HOOKS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


heartbeat_decision = load("heartbeat_decision_adapter_test", "heartbeat-decision.py")
board_observation = load("heartbeat_board_observation_test", "heartbeat-board-observation.py")


class HeartbeatBoardObservationTest(unittest.TestCase):
    def setUp(self):
        self.store = tempfile.NamedTemporaryFile(suffix=".db")
        connection = sqlite3.connect(self.store.name)
        connection.executescript(
            """
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
                "root-1", 12, "notice", "request", "asking-session", "Need a ruling",
                "2099-01-15T09:00:00.000Z", None, None,
            ),
        )
        connection.commit()
        connection.close()

    def tearDown(self):
        self.store.close()

    def observe(self):
        return board_observation.observe_board_requests(
            self.store.name,
            "asking-session",
            heartbeat_decision.contains_secret_shaped,
        )

    def open(self):
        rows = self.observe()
        roots = [root for root in rows["roots"] if root["author_session"] == "asking-session"]
        return heartbeat_decision.open_board_requests(
            roots, rows["replies"], "asking-session", 1_800_000_000
        )

    def reply(self, record_id, author, delivered):
        connection = sqlite3.connect(self.store.name)
        connection.execute(
            "INSERT INTO board_message VALUES (?,?,?,?,?,?,?,?,?)",
            (record_id, 13, "reply", None, author, None, None, None, "root-1"),
        )
        connection.execute(
            "INSERT INTO board_receipt VALUES (?,?,?)",
            (record_id, "asking-session", delivered),
        )
        connection.commit()
        connection.close()

    def test_projection_and_policy_release_only_for_delivered_external_reply(self):
        projected = self.observe()
        self.assertEqual(projected["roots"][0]["label"], "board:12 Need a ruling")
        self.assertEqual([row["id"] for row in self.open()], ["root-1"])

        self.reply("self-reply", "asking-session", "2027-01-15T08:00:00.000Z")
        self.assertEqual([row["id"] for row in self.open()], ["root-1"])

        self.reply("undelivered-reply", "answering-session", None)
        self.assertEqual([row["id"] for row in self.open()], ["root-1"])

        self.reply("delivered-reply", "answering-session", "2027-01-15T08:00:00.000Z")
        self.assertEqual(self.open(), [])

    def test_secret_shaped_title_is_withheld(self):
        connection = sqlite3.connect(self.store.name)
        connection.execute("UPDATE board_message SET title=? WHERE record_id='root-1'", ("token=abc",))
        connection.commit()
        connection.close()
        self.assertEqual(
            self.observe()["roots"][0]["label"],
            "board:12 title withheld (secret-shaped)",
        )


if __name__ == "__main__":
    unittest.main()
