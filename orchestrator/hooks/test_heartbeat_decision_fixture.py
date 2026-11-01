"""Heartbeat fixture staging stays aligned with the runtime fingerprint."""

import re
import unittest

from heartbeat_decision_fixture import HEARTBEAT_SOURCE_NAMES, PATH


class HeartbeatDecisionFixtureTest(unittest.TestCase):
    def test_staged_sources_match_fingerprinted_sources(self):
        source = PATH.with_name("orch-heartbeat.sh").read_text(encoding="utf-8")
        body = re.search(
            r"heartbeat_source_fingerprint\(\) \{\s*cksum (?P<paths>.*?) 2>/dev/null\s*\}",
            source,
            re.DOTALL,
        )
        self.assertIsNotNone(body)
        tokens = re.findall(r'"([^"]+)"', body.group("paths"))
        fingerprinted = {
            "orchestrator/hooks/orch-heartbeat.sh"
            if token == "$SCRIPT_PATH"
            else token.replace("$ROOT/hooks/", "orchestrator/hooks/").replace(
                "$ROOT/../shared/", "shared/"
            )
            for token in tokens
        }
        staged = {
            *(f"orchestrator/hooks/{name}" for name in HEARTBEAT_SOURCE_NAMES),
            "shared/secret-shaped-rules.json",
        }
        self.assertEqual(fingerprinted, staged)


if __name__ == "__main__":
    unittest.main()
