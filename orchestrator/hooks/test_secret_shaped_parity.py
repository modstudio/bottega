"""The Python hook adapter shares the canonical secret-shaped parity corpus."""

import json
import unittest
from pathlib import Path

from secret_shaped import redact_secret_shaped


CORPUS = Path(__file__).resolve().parents[2] / "shared" / "secret-shaped-parity.json"
PEM_BEGIN = "".join(("-----BEGIN ", "PRIVATE KEY-----"))
PEM_END = "".join(("-----END ", "PRIVATE KEY-----"))


def expand_pem_placeholders(text: str) -> str:
    return text.replace("{PEM_BEGIN}", PEM_BEGIN).replace("{PEM_END}", PEM_END)


class SecretShapedParityTest(unittest.TestCase):
    def test_shared_redaction_corpus(self):
        fixtures = json.loads(CORPUS.read_text(encoding="utf-8"))
        for fixture in fixtures:
            with self.subTest(fixture["name"]):
                self.assertEqual(
                    redact_secret_shaped(
                        expand_pem_placeholders(fixture["input"]),
                        fixture["exemptEvidenceTokens"],
                    ),
                    (expand_pem_placeholders(fixture["text"]), fixture["rules"]),
                )


if __name__ == "__main__":
    unittest.main()
