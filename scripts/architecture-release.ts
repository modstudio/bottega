export const releaseModules = [
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
