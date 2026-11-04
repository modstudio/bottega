import contextlib
import io
import os
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from registered_scope import should_hook_act
from registered_scope_decision import PROCESS_CWD, hook_acts, invocation_directory


class RegisteredScopeDecisionTest(unittest.TestCase):
    def test_invocation_directory_precedence(self):
        env = {
            "CLAUDE_PROJECT_DIR": "/claude",
            "GROK_WORKSPACE_ROOT": "/grok",
            PROCESS_CWD: "/process",
        }
        self.assertEqual(invocation_directory({"cwd": "/payload"}, env), "/claude")
        del env["CLAUDE_PROJECT_DIR"]
        self.assertEqual(invocation_directory({"cwd": "/payload"}, env), "/grok")
        del env["GROK_WORKSPACE_ROOT"]
        self.assertEqual(invocation_directory({"cwd": "/payload"}, env), "/payload")
        self.assertEqual(invocation_directory({}, env), "/process")

    def test_global_use_absent_acts(self):
        self.assertTrue(hook_acts(None, [], "/outside"))

    def test_off_outside_registered_project_does_not_act(self):
        self.assertFalse(hook_acts("off", ["/project"], "/outside"))

    def test_off_inside_registered_project_subdirectory_acts(self):
        self.assertTrue(hook_acts("off", ["/project"], "/project/nested"))

    def test_off_sibling_with_shared_prefix_does_not_act(self):
        self.assertFalse(hook_acts("off", ["/x/proj"], "/x/project2"))

    def test_unknown_registered_paths_acts(self):
        self.assertTrue(hook_acts("off", None, "/outside"))


class RegisteredScopeAdapterTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = self.temporary.name
        self.store = os.path.join(self.root, "orchestrator.db")

    def tearDown(self):
        self.temporary.cleanup()

    def create_store(self, schema="path TEXT NOT NULL, retired_at TEXT"):
        database = sqlite3.connect(self.store)
        database.execute(f"CREATE TABLE project ({schema})")
        database.commit()
        database.close()

    def environment(self):
        return patch.dict(
            os.environ,
            {"BOTTEGA_GLOBAL_USE": "off", "BOTTEGA_ORCHESTRATOR_DB": self.store},
            clear=True,
        )

    def test_open_store_filters_retired_projects(self):
        self.create_store()
        database = sqlite3.connect(self.store)
        database.executemany(
            "INSERT INTO project (path, retired_at) VALUES (?, ?)",
            [(self.root, "2026-01-01"), (os.path.join(self.root, "active"), None)],
        )
        database.commit()
        database.close()
        with self.environment():
            self.assertFalse(should_hook_act({"cwd": os.path.join(self.root, "retired")}))
            self.assertTrue(should_hook_act({"cwd": os.path.join(self.root, "active", "nested")}))

    def test_wrong_project_shape_acts_and_names_store(self):
        self.create_store("path TEXT NOT NULL")
        stderr = io.StringIO()
        with self.environment(), contextlib.redirect_stderr(stderr):
            self.assertTrue(should_hook_act({"cwd": self.root}))
        self.assertIn(self.store, stderr.getvalue())

    def test_missing_store_acts_and_names_store(self):
        stderr = io.StringIO()
        with self.environment(), contextlib.redirect_stderr(stderr):
            self.assertTrue(should_hook_act({"cwd": self.root}))
        self.assertIn(self.store, stderr.getvalue())

    def test_unset_store_acts_and_names_condition(self):
        stderr = io.StringIO()
        with patch.dict(os.environ, {"BOTTEGA_GLOBAL_USE": "off"}, clear=True), contextlib.redirect_stderr(stderr):
            self.assertTrue(should_hook_act({"cwd": self.root}))
        self.assertIn("BOTTEGA_ORCHESTRATOR_DB", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
