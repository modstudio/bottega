export const releaseModules = [
  {
    file: 'orchestrator/src/release/release-decision.ts',
    allowed: ['shared/release-tag.ts'],
  },
  {
    file: 'orchestrator/src/release/release-service.ts',
    allowed: [
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
      'orchestrator/src/release/release-outbox.ts',
    ],
  },
  {
    file: 'orchestrator/src/release/release-outbox.ts',
    allowed: [
      'bun:sqlite',
      'shared/record/schema.ts',
      'orchestrator/src/database/db.ts',
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
  {
    file: 'release/bottega.ts',
    allowed: [
      'hub/src/cli.ts',
      'orchestrator/src/ask/ask-proxy.ts',
      'orchestrator/src/check/check-attribution.ts',
      'orchestrator/src/check/check-strict-schema.ts',
      'orchestrator/src/cli/orch.ts',
      'orchestrator/src/run/exec.ts',
      'retrieval/src/search-cli.ts',
      'shared/brand.ts',
      'shared/install-root.ts',
      'release/dispatch.ts',
    ],
  },
  {
    file: 'release/dispatch.ts',
    allowed: ['node:path', 'shared/brand.ts', 'shared/self-spawn.ts'],
  },
]
