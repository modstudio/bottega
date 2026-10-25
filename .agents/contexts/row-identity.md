---
description: Every table's primary key is a UUID; integers are labels or local order only.
paths:
  - orchestrator/migrations/**
  - hub/migrations/**
  - shared/record/**
  - scripts/identity-key-manifest.ts
  - scripts/identity-key-baseline.json
---

# Key every row by a UUID

Every table's primary key is a UUID minted when its row is created, and every reference to a row holds that UUID. Rows move between machines, the hub and the hosted record, and only a UUID names the same row in all of them; a per-machine integer or a natural key collides as soon as two machines sync.

An auto-incrementing integer may stand beside the key as a label a person reads, such as a note or cursor number, or as a local ordering sequence. It is never a primary key or a foreign key, and it never leaves the machine as a reference.

A table whose rows never leave the machine, and that no synced row references, may keep another key only when `scripts/identity-key-manifest.ts` declares it with that reason. A declared table that starts syncing loses the exemption. `scripts/check-identity-inventory.ts` refuses any key that `scripts/identity-key-baseline.json` does not already hold, and that baseline only shrinks.
