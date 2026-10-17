export const CHECK_LEGS = [
  {
    name: 'orchestrator',
    directory: 'orchestrator',
    ciJob: 'orchestrator',
    typecheck: ['bun', 'run', 'typecheck'],
    suite: [['bun', 'run', 'test:gate']],
  },
  {
    name: 'hub',
    directory: 'hub',
    ciJob: 'hub',
    typecheck: ['bun', 'run', 'typecheck'],
    suite: [
      ['bun', 'run', 'test'],
      ['bun', 'run', '--cwd', 'data', 'test'],
    ],
  },
  {
    name: 'hub/web',
    directory: 'hub/web',
    ciJob: 'hub-web',
    typecheck: ['bun', 'run', 'typecheck'],
    suite: [
      ['bun', 'run', 'test'],
      ['bun', 'run', 'build'],
    ],
  },
  {
    name: 'hub/deploy/site',
    directory: 'hub/deploy/site',
    ciJob: 'hub-deploy-site',
    typecheck: ['bun', 'run', 'typecheck'],
    suite: [['bun', 'run', 'test']],
  },
  {
    name: 'retrieval',
    directory: 'retrieval',
    ciJob: 'retrieval',
    typecheck: ['bun', 'run', 'typecheck'],
    suite: [['bun', 'run', 'test']],
  },
] as const

/** CI-only process checks that are intentionally outside the in-process local gate. */
export const CI_ONLY_JOBS = ['hub-ui-stories', 'hub-web-smoke'] as const

export const STATIC_OMIT_GROUPS = {
  'machine-only': {
    reason: "CI runners do not have this machine's project register and canon store",
    checks: ['project checks', 'scripts/check-canon-drift.ts'],
  },
  secrets: {
    reason: 'the CI secrets job runs the same gitleaks scan in its container',
    checks: ['scripts/check-gitleaks.ts'],
  },
} as const
