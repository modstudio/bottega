import importlib.util
import os
import sqlite3
import tempfile
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path


PATH = Path(__file__).with_name("board-interrupt.py")
SPEC = importlib.util.spec_from_file_location("board_interrupt", PATH)
board_interrupt = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(board_interrupt)


class BoardInterruptPresenceTest(unittest.TestCase):
    def test_birth_time_from_stat_becomes_an_iso_instant(self):
        stamp = datetime(2026, 10, 13, 12, 0, 0, 123000, tzinfo=timezone.utc)
        began = board_interrupt.session_began_at_from_stat(
            types.SimpleNamespace(st_birthtime=stamp.timestamp())
        )
        self.assertEqual(began, "2026-10-13T12:00:00.123Z")

    def test_missing_birth_time_falls_back_to_the_first_transcript_timestamp(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "transcript.jsonl")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write('{"type":"user","timestamp":"2026-10-13T12:00:00.000Z"}\n')
                handle.write('{"type":"assistant","timestamp":"2026-10-13T12:01:00.000Z"}\n')
            self.assertEqual(
                board_interrupt.session_began_at_from_transcript(path),
                "2026-10-13T12:00:00.000Z",
            )
            self.assertIsNone(
                board_interrupt.session_began_at_from_stat(types.SimpleNamespace())
            )

    def test_skip_reason_when_no_transcript_or_start(self):
        self.assertEqual(board_interrupt.presence_skip_reason(None), "no transcript_path")
        self.assertEqual(board_interrupt.presence_skip_reason(""), "no transcript_path")
        with tempfile.TemporaryDirectory() as folder:
            missing = os.path.join(folder, "missing.jsonl")
            self.assertEqual(
                board_interrupt.presence_skip_reason(missing),
                "no session start from transcript",
            )
            empty = os.path.join(folder, "empty.jsonl")
            Path(empty).write_text("", encoding="utf-8")
            os.utime(empty, (0, 0))
            began = board_interrupt.session_began_at_from_transcript(empty)
            self.assertIsNone(began)

    def test_cheap_state_includes_a_pending_withdrawal_until_it_is_delivered(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "orchestrator.db")
            connection = sqlite3.connect(path)
            connection.executescript(
                """
                CREATE TABLE board_message(record_id TEXT,number INTEGER,kind TEXT,
                  ack_required INTEGER,withdrawn_at TEXT,expires_at TEXT,
                  author_session TEXT,thread_root_record_id TEXT);
                CREATE TABLE board_receipt(message_record_id TEXT,reader_session TEXT,
                  delivered_at TEXT,acknowledged_at TEXT);
                CREATE TABLE hosted_board_message_cache(id TEXT,kind TEXT,payload TEXT);
                CREATE TABLE hosted_board_receipt_cache(message_id TEXT,reader_session TEXT,
                  delivered_at TEXT,acknowledged_at TEXT);
                CREATE TABLE board_withdrawal_delivery(record_id TEXT PRIMARY KEY,
                  reader_session TEXT,message_record_id TEXT,source TEXT,
                  delivered_at TEXT,UNIQUE(reader_session,message_record_id));
                CREATE TABLE schema_meta(key TEXT PRIMARY KEY,value TEXT);
                INSERT INTO schema_meta VALUES
                  ('board_hosted_refresh_at','2026-10-30T12:00:00.000Z');
                INSERT INTO board_message VALUES
                  ('message-id',7,'notice',0,'2026-10-30T11:00:00.000Z',
                   '2026-10-31T12:00:00.000Z','author',NULL);
                INSERT INTO board_receipt VALUES
                  ('message-id','reader','2026-10-30T10:00:00.000Z',NULL);
                """
            )
            connection.commit()
            previous = os.environ.get("BOTTEGA_ORCHESTRATOR_DB")
            os.environ["BOTTEGA_ORCHESTRATOR_DB"] = path
            try:
                candidates, _ = board_interrupt.cheap_state("reader", 300)
                self.assertIn("withdrawn:7", candidates)
                connection.execute(
                    "INSERT INTO board_withdrawal_delivery VALUES (?,?,?,?,?)",
                    (
                        "delivery-id",
                        "reader",
                        "message-id",
                        "local",
                        "2026-10-30T11:01:00.000Z",
                    ),
                )
                connection.commit()
                candidates, _ = board_interrupt.cheap_state("reader", 300)
                self.assertNotIn("withdrawn:7", candidates)
            finally:
                if previous is None:
                    os.environ.pop("BOTTEGA_ORCHESTRATOR_DB", None)
                else:
                    os.environ["BOTTEGA_ORCHESTRATOR_DB"] = previous
                connection.close()

    def test_cheap_state_keeps_ordinary_candidates_without_withdrawal_table(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "orchestrator.db")
            connection = sqlite3.connect(path)
            connection.executescript(
                """
                CREATE TABLE board_message(record_id TEXT,number INTEGER,kind TEXT,
                  ack_required INTEGER,withdrawn_at TEXT,expires_at TEXT,
                  author_session TEXT,thread_root_record_id TEXT);
                CREATE TABLE board_receipt(message_record_id TEXT,reader_session TEXT,
                  delivered_at TEXT,acknowledged_at TEXT);
                CREATE TABLE hosted_board_message_cache(id TEXT,kind TEXT,payload TEXT);
                CREATE TABLE hosted_board_receipt_cache(message_id TEXT,reader_session TEXT,
                  delivered_at TEXT,acknowledged_at TEXT);
                CREATE TABLE schema_meta(key TEXT PRIMARY KEY,value TEXT);
                INSERT INTO schema_meta VALUES
                  ('board_hosted_refresh_at','2026-10-30T12:00:00.000Z');
                INSERT INTO board_message VALUES
                  ('local-live',8,'notice',0,NULL,'2099-10-31T12:00:00.000Z',
                   'author',NULL),
                  ('local-withdrawn',9,'notice',0,'2026-10-30T11:00:00.000Z',
                   '2099-10-31T12:00:00.000Z','author',NULL);
                INSERT INTO board_receipt VALUES
                  ('local-withdrawn','reader','2026-10-30T10:00:00.000Z',NULL);
                INSERT INTO hosted_board_message_cache VALUES
                  ('hosted-live','notice',
                   '{"withdrawnAt":null,"expiresAt":"2099-10-31T12:00:00.000Z",' ||
                   '"authorSession":"author","ackRequired":false,"threadRootId":null}'),
                  ('hosted-withdrawn','notice',
                   '{"withdrawnAt":"2026-10-30T11:00:00.000Z",' ||
                   '"expiresAt":"2099-10-31T12:00:00.000Z",' ||
                   '"authorSession":"author","ackRequired":false,"threadRootId":null}');
                INSERT INTO hosted_board_receipt_cache VALUES
                  ('hosted-withdrawn','reader','2026-10-30T10:00:00.000Z',NULL);
                """
            )
            connection.commit()
            previous = os.environ.get("BOTTEGA_ORCHESTRATOR_DB")
            os.environ["BOTTEGA_ORCHESTRATOR_DB"] = path
            try:
                candidates, _ = board_interrupt.cheap_state("reader", 300)
                self.assertIn("8", candidates)
                self.assertIn("hosted-live", candidates)
                self.assertFalse(any(item.startswith("withdrawn:") for item in candidates))
            finally:
                if previous is None:
                    os.environ.pop("BOTTEGA_ORCHESTRATOR_DB", None)
                else:
                    os.environ["BOTTEGA_ORCHESTRATOR_DB"] = previous
                connection.close()


if __name__ == "__main__":
    unittest.main()
