---
description: Table lifecycle and identity-state classification rules
paths:
  - shared/record/**
  - scripts/identity-state-classes.ts
  - shared/identity-state-classes.ts
  - scripts/check-identity-inventory.ts
---

# Table lifecycle

Every table declares a lifecycle: what it is, where its authoritative copy
lives, how long each copy is kept and what removes it. Tables declare
`hosted`, `synced` or `machine` in
`scripts/identity-state-classes.ts` or `shared/identity-state-classes.ts`, machine ones naming the user's ruling;
`scripts/check-identity-inventory.ts` enforces both. Doc-store records
`design-machine-hosted-seam` and `design-data-lifecycle` hold detail.
