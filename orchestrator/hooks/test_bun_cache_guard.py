import json
import subprocess
import unittest
from pathlib import Path


HOOK = Path(__file__).with_name("bun-cache-guard.py")


def invoke(command: str):
    result = subprocess.run(
        ["python3", str(HOOK)],
        input=json.dumps({"tool_name": "Bash", "tool_input": {"command": command}}),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0 or result.stderr:
        raise AssertionError(
            f"hook exited {result.returncode}; stdout={result.stdout!r}; stderr={result.stderr!r}"
        )
    return json.loads(result.stdout) if result.stdout else None


class BunCacheGuardTest(unittest.TestCase):
    def assert_denied(self, command: str):
        output = invoke(command)
        self.assertEqual(output["hookSpecificOutput"]["permissionDecision"], "deny")
        reason = output["hookSpecificOutput"]["permissionDecisionReason"]
        self.assertIn("shared global store", reason)

    def test_denies_plain_cache_removal_and_cleaning(self):
        self.assert_denied("bun pm cache rm")
        self.assert_denied("bun pm cache clean")

    def test_refuses_cache_commands_embedded_in_larger_shell_input(self):
        self.assert_denied("bun install\nbun pm cache rm")
        self.assert_denied("bun install && bun pm cache rm")

    def test_denies_prefixed_forms(self):
        self.assert_denied("sudo bun pm cache rm")
        self.assert_denied("env BUN_CONFIG_VERBOSE_FETCH=1 bun pm cache clean")
        self.assert_denied("bash -c 'bun pm cache rm'")

    def test_refuses_absolute_bun_path_and_cache_phrase_after_bunx(self):
        self.assert_denied("/opt/homebrew/bin/bun pm cache rm")
        self.assert_denied("bunx bun pm cache rm")

    def test_denies_recursive_removal_of_shared_cache(self):
        self.assert_denied("rm -rf ~/.bun/install/cache")
        self.assert_denied("rm -Rf $HOME/.bun/install/cache")
        self.assert_denied("/bin/rm -R $HOME/.bun/install/cache/links")
        self.assert_denied("rm --recursive /Users/operator/.bun/install/cache")

    def test_allows_safe_bun_commands(self):
        self.assertIsNone(invoke("bun install --force"))
        self.assertIsNone(invoke("bun pm ls"))

    def test_refuses_a_quoted_mention_by_design(self):
        self.assert_denied("echo 'do not run bun pm cache rm'")

    def test_fails_open_on_invalid_input(self):
        result = subprocess.run(
            ["python3", str(HOOK)],
            input="not json",
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))


if __name__ == "__main__":
    unittest.main()
