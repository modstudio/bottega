---
description: Rules for current, compact, resolvable canon and documentation
always: true
---

# Writing canon

## State what is

Canon, documentation and comments state the current rule, constraint or
behaviour and what to do about it. Never narrate former names, abandoned
approaches, dated decisions or the sequence by which the current state arose;
Git holds that record. A reason explains why the rule is current without
telling its history.

## Keep canon editorial

Canon holds rules, invariants, gotchas and reasons that an agent would get
wrong without being told. Delete overviews visible in code and explanations of
how a mechanism came to be.

Do not put numerals in prose. Name a value by its constant or configuration
key, and name a measurement by the command that reports it.

When a check or configuration enforces a rule, state the rule once and name
the enforcement. Do not restate the configuration.

Do not maintain command-reference tables. Name the verb needed by a rule;
`orch --help`, `orch <verb> --help` and `hub --help` own flags and usage.

Every cited repository path, symbol, code name and package script must resolve
on the tree. Find and cite the current location or drop a stale citation while
preserving the rule.

Every new canon file must have no `orch canon lint` findings. Regenerate
`scripts/quality/canon-lint.json` so it records only findings in files outside
the change. Never add a changed file's finding to the baseline.
