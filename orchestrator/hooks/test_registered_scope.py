import contextlib
import io
import os
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from registered_scope import PLATFORM_SLUG, _store_path, should_hook_act


class RegisteredScopeTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = self.temporary.name
        self.config = os.path.join(self.root, "config")
        self.store = os.path.join(self.root, "orchestrator.db")
        os.mkdir(self.config)
        database = sqlite3.connect(self.store)
        database.execute("CREATE TABLE project (path TEXT NOT NULL)")
        database.commit()
        database.close()
        self.environment = patch.dict(
            os.environ,
            {
                "BOTTEGA_CONFIG_HOME": self.config,
                "BOTTEGA_ORCHESTRATOR_DB": self.store,
            },
            clear=True,
        )
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.temporary.cleanup()

    def set_global_use_off(self):
        with open(os.path.join(self.config, "machine.toml"), "w", encoding="utf-8") as handle:
            handle.write('[machine]\nglobal_use = "off"\n')

    def register(self, path):
        database = sqlite3.connect(self.store)
        database.execute("INSERT INTO project (path) VALUES (?)", (path,))
        database.commit()
        database.close()

    def test_absent_global_use_acts(self):
        self.assertTrue(should_hook_act({"cwd": os.path.join(self.root, "outside")}))

    def test_off_outside_registered_project_does_not_act(self):
        self.set_global_use_off()
        self.assertFalse(should_hook_act({"cwd": os.path.join(self.root, "outside")}))

    def test_off_inside_registered_project_subdirectory_acts(self):
        self.set_global_use_off()
        project = os.path.join(self.root, "proj")
        directory = os.path.join(project, "nested")
        os.makedirs(directory)
        self.register(project)
        self.assertTrue(should_hook_act({"cwd": directory}))

    def test_off_sibling_with_shared_prefix_does_not_act(self):
        self.set_global_use_off()
        project = os.path.join(self.root, "proj")
        sibling = os.path.join(self.root, "project2")
        os.mkdir(project)
        os.mkdir(sibling)
        self.register(project)
        self.assertFalse(should_hook_act({"cwd": sibling}))

    def test_off_unreadable_store_does_not_act_and_names_path(self):
        self.set_global_use_off()
        unreadable = os.path.join(self.root, "missing.db")
        os.environ["BOTTEGA_ORCHESTRATOR_DB"] = unreadable
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.assertFalse(should_hook_act({"cwd": self.root}))
        self.assertIn(unreadable, stderr.getvalue())

    def test_store_variable_wins(self):
        configured = os.path.join(self.root, "configured.db")
        os.environ.update(
            {
                "BOTTEGA_ORCHESTRATOR_DB": configured,
                "BOTTEGA_STATE_HOME": os.path.join(self.root, "state"),
                "XDG_STATE_HOME": os.path.join(self.root, "xdg"),
                "HOME": os.path.join(self.root, "home"),
            }
        )
        self.assertEqual(_store_path(), configured)

    def test_state_home_wins_over_xdg_and_home(self):
        state_home = os.path.join(self.root, "state")
        os.environ.pop("BOTTEGA_ORCHESTRATOR_DB")
        os.environ.update(
            {
                "BOTTEGA_STATE_HOME": state_home,
                "XDG_STATE_HOME": os.path.join(self.root, "xdg"),
                "HOME": os.path.join(self.root, "home"),
            }
        )
        self.assertEqual(
            _store_path(), os.path.join(state_home, "orchestrator", "orchestrator.db")
        )

    def test_xdg_state_home_wins_over_home(self):
        xdg = os.path.join(self.root, "xdg")
        os.environ.pop("BOTTEGA_ORCHESTRATOR_DB")
        os.environ.update(
            {
                "XDG_STATE_HOME": xdg,
                "HOME": os.path.join(self.root, "home"),
            }
        )
        self.assertEqual(
            _store_path(),
            os.path.join(xdg, PLATFORM_SLUG, "orchestrator", "orchestrator.db"),
        )

    def test_home_is_the_final_state_root_fallback(self):
        home = os.path.join(self.root, "home")
        os.environ.pop("BOTTEGA_ORCHESTRATOR_DB")
        os.environ["HOME"] = home
        self.assertEqual(
            _store_path(),
            os.path.join(
                home, ".local", "state", PLATFORM_SLUG, "orchestrator", "orchestrator.db"
            ),
        )

    def test_relative_state_home_is_unresolvable(self):
        os.environ.pop("BOTTEGA_ORCHESTRATOR_DB")
        os.environ["BOTTEGA_STATE_HOME"] = "relative/state"
        with self.assertRaisesRegex(ValueError, "BOTTEGA_STATE_HOME must be absolute"):
            _store_path()


if __name__ == "__main__":
    unittest.main()
