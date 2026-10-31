export const releaseModules = [
  {
    file: 'orchestrator/src/release/release-decision.ts',
    allowed: ['shared/release-tag.ts'],
  },
  {
    file: 'orchestrator/src/release/release-service.ts',
    allowed: [
      'shared/brand.ts',
      'node:fs',
      'node:path',
      'orchestrator/src/database/db.ts',
      'orchestrator/src/gate/gate-decision.ts',
      'orchestrator/src/git/git-environment.ts',
      'orchestrator/src/project/project-lock.ts',
      'orchestrator/src/project/projects.ts',
      'shared/install-root.ts',
      'shared/secret-shaped.ts',
      'shared/record/schema.ts',
      'orchestrator/src/release/release-decision.ts',
      'orchestrator/src/release/live-reading.ts',
      'orchestrator/src/release/release-ledger.ts',
    ],
  },
  {
    file: 'orchestrator/src/release/release-required.ts',
    allowed: [
      'shared/brand.ts',
      'orchestrator/src/git/git-environment.ts',
      'orchestrator/src/project/projects.ts',
      'orchestrator/src/release/release-service.ts',
    ],
    typeOnlyAllowed: ['orchestrator/src/project/projects.ts'],
  },
  {
    file: 'orchestrator/src/release/release-ledger.ts',
    allowed: [
      'shared/brand.ts',
      'bun:sqlite',
      'node:os',
      'shared/record/schema.ts',
      'orchestrator/src/database/db.ts',
      'orchestrator/src/release/release-outbox.ts',
    ],
  },
  {
    file: 'orchestrator/src/release/release-outbox.ts',
    allowed: [
      'bun:sqlite',
      'shared/record-id.ts',
      'shared/record/schema.ts',
      'orchestrator/src/database/db.ts',
      'orchestrator/src/record/machine-identity.ts',
      'orchestrator/src/record/outbox-sanitize.ts',
    ],
  },
  {
    file: 'orchestrator/src/release/live-reading.ts',
    allowed: [
      'shared/secret-shaped.ts',
      'orchestrator/src/git/git-environment.ts',
      'orchestrator/src/release/release-decision.ts',
    ],
  },
]
