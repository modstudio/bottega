import importlib.util
import os
import sqlite3
import tempfile
import unittest
import uuid


PATH = os.path.join(os.path.dirname(__file__), "block-agent.py")


class SpawnIdentityTest(unittest.TestCase):
    def test_logged_spawn_has_version_seven_record_id(self):
        with tempfile.TemporaryDirectory() as folder:
            database = os.path.join(folder, "orch.db")
            connection = sqlite3.connect(database)
            connection.execute(
                """CREATE TABLE spawn (
                  record_id TEXT NOT NULL UNIQUE, at TEXT NOT NULL, session_id TEXT, cwd TEXT,
                  event TEXT, subagent_type TEXT, description TEXT, prompt_bytes INTEGER,
                  decision TEXT NOT NULL, why TEXT NOT NULL
                )"""
            )
            connection.close()
            previous = os.environ.get("ORCH_DB")
            os.environ["ORCH_DB"] = database
            try:
                spec = importlib.util.spec_from_file_location("block_agent", PATH)
                block_agent = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(block_agent)
                block_agent.log("allowed", "test", {}, "PreToolUse", {})
            finally:
                if previous is None:
                    os.environ.pop("ORCH_DB", None)
                else:
                    os.environ["ORCH_DB"] = previous
            connection = sqlite3.connect(database)
            record_id = connection.execute("SELECT record_id FROM spawn").fetchone()[0]
            connection.close()
            parsed = uuid.UUID(record_id)
            self.assertEqual(parsed.version, 7)
            self.assertEqual(record_id, str(parsed))


if __name__ == "__main__":
    unittest.main()
