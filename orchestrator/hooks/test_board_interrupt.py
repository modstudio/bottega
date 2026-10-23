import importlib.util
import os
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


if __name__ == "__main__":
    unittest.main()
