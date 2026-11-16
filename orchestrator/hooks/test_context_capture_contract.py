#!/usr/bin/env python3
"""Guard the section-heading contract between compaction hooks."""
import importlib.util
import re
import unittest
from pathlib import Path


def load_hook(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    hook = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hook)
    return hook


context_precompact = load_hook("context_precompact_contract", "context-precompact.py")
session_brief = load_hook("session_brief_contract", "session-brief.py")


class ContextCaptureContract(unittest.TestCase):
    def test_first_act_names_the_session_compaction_source(self):
        self.assertEqual(
            re.search(
                r'--source "([^"]+)"',
                session_brief.COMPACT_FIRST_ACT.format(session="session-a"),
            ).group(1),
            "compaction session-a",
        )

    def test_capture_and_first_act_quote_the_same_section_heading(self):
        capture_heading = re.search(
            r"section headed '([^']+)'", context_precompact.CAPTURE_INSTRUCTION
        )
        first_act_heading = re.search(
            r"summary's '([^']+)' section",
            session_brief.COMPACT_FIRST_ACT.format(session="session-a"),
        )

        self.assertIsNotNone(capture_heading)
        self.assertIsNotNone(first_act_heading)
        self.assertEqual(capture_heading.group(1), first_act_heading.group(1))


if __name__ == "__main__":
    unittest.main()
