"""The Python hook adapter shares the canonical secret-shaped parity corpus."""

import json
import unittest
from pathlib import Path

from secret_shaped import redact_secret_shaped, validate_secret_shaped_rule_table


CORPUS = Path(__file__).resolve().parents[2] / "shared" / "secret-shaped-parity.json"
RULE_TABLE = Path(__file__).resolve().parents[2] / "shared" / "secret-shaped-rules.json"
PEM_BEGIN = "".join(("-----BEGIN ", "PRIVATE KEY-----"))
PEM_END = "".join(("-----END ", "PRIVATE KEY-----"))


def expand_pem_placeholders(text: str) -> str:
    return text.replace("{PEM_BEGIN}", PEM_BEGIN).replace("{PEM_END}", PEM_END)


class SecretShapedParityTest(unittest.TestCase):
    def test_shared_redaction_corpus(self):
        corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
        for fixture in corpus["cases"]:
            with self.subTest(fixture["name"]):
                input_parts = fixture.get("inputParts")
                input_text = "".join(input_parts) if input_parts else fixture["input"]
                self.assertEqual(
                    redact_secret_shaped(
                        expand_pem_placeholders(input_text),
                        fixture["exemptEvidenceTokens"],
                    ),
                    (expand_pem_placeholders(fixture["text"]), fixture["rules"]),
                )

    def test_real_rules_table_passes_shared_validation(self):
        table = json.loads(RULE_TABLE.read_text(encoding="utf-8"))
        self.assertIs(validate_secret_shaped_rule_table(table), table)

    def test_invalid_tables_are_refused_by_shared_validation(self):
        corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
        real_table = json.loads(RULE_TABLE.read_text(encoding="utf-8"))
        for mutation in corpus["invalidTables"]:
            with self.subTest(mutation["name"]):
                candidate = json.loads(json.dumps(real_table))
                target = (
                    candidate["rules"][mutation.get("ruleIndex", 0)]
                    if mutation["target"] == "rule"
                    else candidate
                )
                if mutation.get("remove"):
                    del target[mutation["field"]]
                else:
                    target[mutation["field"]] = mutation["value"]
                with self.assertRaises(ValueError):
                    validate_secret_shaped_rule_table(candidate)


if __name__ == "__main__":
    unittest.main()
