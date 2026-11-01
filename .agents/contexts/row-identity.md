---
description: Every table's primary key is a UUID; integers are labels or local order only.
paths:
  - orchestrator/migrations/**
  - hub/migrations/**
  - shared/record/**
  - scripts/identity-key-manifest.ts
  - scripts/identity-key-baseline.json
  - scripts/identity-synced-sources.ts
  - scripts/identity-client-enumeration.ts
---

# Key every row by a UUID

Every table's primary key is a UUID minted when its row is created, and every reference to a row holds that UUID. Rows move between machines, the hub and the hosted record, and only a UUID names the same row in all of them; a per-machine integer or a natural key collides as soon as two machines sync.

An auto-incrementing integer may stand beside the key as a label a person reads, such as a note or cursor number, or as a local ordering sequence. It is never a primary key or a foreign key, and it never leaves the machine as a reference.

A readable natural key may stand beside a UUID reference as a display label when `scripts/identity-key-manifest.ts` declares it with its sibling; nothing may resolve the row through the label.

A reference may keep a key that is not a UUID only by operator ruling, when the key is identical on every machine, such as a fingerprint derived from content. The reference must be a declared foreign key, and `scripts/identity-key-manifest.ts` lists it among its ruled references with its reason and ruling.

A table whose rows never leave the machine, and that no synced row references, may keep another key only when `scripts/identity-key-manifest.ts` declares it with that reason. A declared table that starts syncing loses the exemption. `scripts/check-identity-inventory.ts` refuses any key that `scripts/identity-key-baseline.json` does not already hold, and that baseline only shrinks.

