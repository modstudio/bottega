export const CHECK_LEGS = [
  {
    name: 'cli',
    directory: 'cli',
    ciJob: 'cli',
    typecheck: ['bun', 'run', 'typecheck'],
    suite: [],
  },
  {
    name: 'orchestrator',
    directory: 'orchestrator',
    ciJob: 'orchestrator',
    typecheck: ['bun', 'run', 'typecheck'],
    suite: [{ argv: ['bun', 'run', 'test:gate'], unitTests: true }],
  },
  {
    name: 'hub',
    directory: 'hub',
    ciJob: 'hub',
    typecheck: ['bun', 'run', 'typecheck'],
    suite: [
      { argv: ['bun', 'run', 'test'], unitTests: true },
      { argv: ['bun', 'run', '--cwd', 'data', 'test'], unitTests: true },
      { argv: ['bun', 'run', '--cwd', 'site', 'test'], unitTests: true },
      { argv: ['bun', 'run', '--cwd', 'util', 'test'], unitTests: true },
    ],
  },
  {
    name: 'hub/web',
    directory: 'hub/web',
    ciJob: 'hub-web',
    typecheck: ['bun', 'run', 'typecheck'],
    suite: [
      { argv: ['bun', 'run', 'test'], unitTests: true },
      { argv: ['bun', 'run', 'build'], unitTests: false },
    ],
  },
  {
    name: 'hub/deploy/site',
    directory: 'hub/deploy/site',
    ciJob: 'hub-deploy-site',
    typecheck: ['bun', 'run', 'typecheck'],
    suite: [{ argv: ['bun', 'run', 'test'], unitTests: true }],
  },
  {
    name: 'retrieval',
    directory: 'retrieval',
    ciJob: 'retrieval',
    typecheck: ['bun', 'run', 'typecheck'],
    suite: [{ argv: ['bun', 'run', 'test'], unitTests: true }],
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
