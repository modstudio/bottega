import importlib.util
import io
import json
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "context_precompact", Path(__file__).with_name("context-precompact.py")
)
context_precompact = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(context_precompact)


class ContextPrecompactTest(unittest.TestCase):
    def test_hook_has_no_output(self):
        payload = json.dumps({"cwd": "/tmp", "session_id": "session-1"})
        with patch.object(context_precompact, "should_hook_act", return_value=True):
            with patch("sys.stdin", io.StringIO(payload)):
                self.assertEqual(context_precompact.main(), 0)


if __name__ == "__main__":
    unittest.main()
