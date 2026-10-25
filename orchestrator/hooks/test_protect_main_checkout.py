import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch


HOOK_PATH = Path(__file__).with_name("protect-main-checkout.py")
sys.path.insert(0, str(HOOK_PATH.parent))


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hook = load(HOOK_PATH, "protect_main_checkout_hook")


class MainCheckoutHookTest(unittest.TestCase):
    main = "/registered/main"
    worktree = main + "/.claude/worktrees/DEV-1578"
    protected = [{"name": "protected", "path": main, "settings": {}}]
    exempt = [
        {"name": "exempt", "path": main, "settings": {"requireCleanMain": False}}
    ]

    def invoke(self, command, cwd, projects=None, error=None):
        payload = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": cwd}
        output = io.StringIO()
        errors = io.StringIO()
        calls = []

        def database_path():
            calls.append("database")
            return "/fixture/orchestrator.db"

        fixture = self.protected if projects is None else projects
        with (
            patch.object(hook, "database_path", database_path),
            patch.object(hook, "load_projects_result", return_value=(fixture, error)),
            patch.object(sys, "stdin", io.StringIO(json.dumps(payload))),
            redirect_stdout(output),
            redirect_stderr(errors),
        ):
            exit_code = hook.main()
        return {
            "exit_code": exit_code,
            "output": json.loads(output.getvalue()) if output.getvalue() else None,
            "stderr": errors.getvalue(),
            "database_calls": len(calls),
        }

    def invoke_editor(self, path, projects=None, top=None, tracked=True):
        payload = {
            "tool_name": "Write",
            "tool_input": {"file_path": path},
            "cwd": self.main,
        }
        output = io.StringIO()
        fixture = self.protected if projects is None else projects
        with (
            patch.object(hook, "database_path", return_value="/fixture/orchestrator.db"),
            patch.object(hook, "load_projects", return_value=fixture),
            patch.object(hook, "toplevel", return_value=self.main if top is None else top),
            patch.object(hook, "tracked_in_main", return_value=tracked),
            patch.object(sys, "stdin", io.StringIO(json.dumps(payload))),
            redirect_stdout(output),
        ):
            exit_code = hook.main()
        return {
            "exit_code": exit_code,
            "output": json.loads(output.getvalue()) if output.getvalue() else None,
        }

    def assert_denied(self, command, cwd=None):
        result = self.invoke(command, cwd or self.main)
        self.assertEqual(result["exit_code"], 0)
        self.assertEqual(
            result["output"]["hookSpecificOutput"]["permissionDecision"], "deny"
        )
        return result

    def test_recognized_mutations_are_denied_end_to_end(self):
        cases = (
            ("git checkout x", self.main),
            ("git -C /registered/main switch x", "/elsewhere"),
            ("cd /registered/main && git reset --hard", "/elsewhere"),
            ("A=1 git status || git restore file | git log; git clean -n", self.main),
            ("git -C /registered/main commit -m x 2>&1", "/elsewhere"),
            ("git reset --hard", self.main + "/.claude/worktrees"),
            ("git -c core.hooksPath=x reset --hard", self.main),
            ("/usr/bin/git reset --hard", self.main),
            ("git --work-tree /registered/main reset --hard", "/elsewhere"),
            ("git --git-dir /registered/main/.git reset --hard", "/elsewhere"),
            ("git -C/registered/main reset --hard", "/elsewhere"),
            ("git add file", self.main),
            ("git rm file", self.main),
            ("git mv old new", self.main),
            (f"git -C {self.main} reset --hard", self.worktree),
        )
        for command, cwd in cases:
            with self.subTest(command=command):
                self.assert_denied(command, cwd)

    def test_effective_git_c_directory_replaces_starting_cwd(self):
        result = self.invoke(f"git -C {self.worktree} reset --hard", self.main)
        self.assertIsNone(result["output"])

    def test_transparent_wrappers_are_denied(self):
        for command in (
            "env git reset --hard",
            "command git reset --hard",
            "nice -n 5 git reset --hard",
            "timeout 5 git reset --hard",
        ):
            with self.subTest(command=command):
                self.assert_denied(command)

    def test_every_repository_selector_is_checked(self):
        for command in (
            f"git --git-dir={self.main}/.git --work-tree={self.worktree} reset --hard",
            f"GIT_DIR={self.main}/.git git reset --hard",
            f"GIT_WORK_TREE={self.main} git reset --hard",
            f"env GIT_DIR={self.main}/.git git reset --hard",
        ):
            with self.subTest(command=command):
                self.assert_denied(command, "/elsewhere")

    def test_allowed_and_unparseable_commands_fail_open(self):
        cases = (
            ("git status", self.main, self.protected),
            ("git pull --ff-only", self.main, self.protected),
            ("git checkout x", self.worktree, self.protected),
            ("git checkout $(branch-name)", self.main, self.protected),
            ("bash -c 'git reset --hard'", self.main, self.protected),
            ("xargs git reset --hard", self.main, self.protected),
            ("git checkout x", self.main, self.exempt),
        )
        for command, cwd, projects in cases:
            with self.subTest(command=command):
                result = self.invoke(command, cwd, projects)
                self.assertIsNone(result["output"])

    def test_non_git_common_case_does_not_resolve_database(self):
        result = self.invoke("ls", self.main)
        self.assertIsNone(result["output"])
        self.assertEqual(result["database_calls"], 0)

    def test_denial_names_checkout_subcommand_invariant_and_remedy(self):
        result = self.assert_denied("git checkout x")
        reason = result["output"]["hookSpecificOutput"]["permissionDecisionReason"]
        self.assertIn("git checkout", reason)
        self.assertIn(self.main, reason)
        self.assertIn("invariant:", reason)
        self.assertIn("worktree under " + self.main + "/.claude/worktrees", reason)

    def test_register_load_errors_warn_and_fail_open(self):
        for error in (
            "project register is missing",
            "project register is unreadable (fixture)",
        ):
            with self.subTest(error=error):
                result = self.invoke("git reset --hard", self.main, error=error)
                self.assertIsNone(result["output"])
                self.assertIn(error, result["stderr"])

    def test_tracked_editor_write_in_main_is_denied(self):
        path = self.main + "/tracked.txt"
        result = self.invoke_editor(path)
        self.assertEqual(result["exit_code"], 0)
        decision = result["output"]["hookSpecificOutput"]
        self.assertEqual(decision["permissionDecision"], "deny")
        self.assertIn("tracked.txt", decision["permissionDecisionReason"])
        self.assertIn(self.main + "/.claude/worktrees", decision["permissionDecisionReason"])

    def test_editor_write_allows_worktree_untracked_and_exempt_paths(self):
        cases = (
            (self.worktree + "/tracked.txt", self.protected, self.worktree, True),
            (self.main + "/untracked.txt", self.protected, self.main, False),
            (self.main + "/tracked.txt", self.exempt, self.main, True),
        )
        for path, projects, top, tracked in cases:
            with self.subTest(path=path, projects=projects):
                result = self.invoke_editor(path, projects, top, tracked)
                self.assertIsNone(result["output"])


if __name__ == "__main__":
    unittest.main()
