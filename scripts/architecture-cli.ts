import { PLATFORM_SLUG } from '../shared/brand.ts'

export const cliConcernEntries = [
  'hub/src/cli.ts',
  'orchestrator/src/ask/ask-proxy.ts',
  'orchestrator/src/check/check-attribution.ts',
  'orchestrator/src/check/check-strict-schema.ts',
  'orchestrator/src/cli/orch.ts',
  'orchestrator/src/run/exec.ts',
  'retrieval/src/search-cli.ts',
] as const

export const cliModules = [
  {
    file: `cli/${PLATFORM_SLUG}.ts`,
    allowed: [...cliConcernEntries, 'shared/install-root.ts', 'cli/dispatch.ts'],
  },
  {
    file: 'cli/dispatch.ts',
    allowed: [
      'node:path',
      'shared/brand.ts',
      'shared/self-spawn.ts',
      'cli/legacy-calls.ts',
      'cli/routes.ts',
    ],
  },
  {
    file: 'cli/legacy-calls.ts',
    allowed: ['node:fs', 'node:path', 'shared/brand.ts', 'shared/state-directory.ts'],
  },
  { file: 'cli/routes.ts', allowed: [] },
  {
    file: 'cli/routes.test.ts',
    allowed: [
      'commander',
      'shared/brand.ts',
      'hub/src/cli-program.ts',
      'orchestrator/src/cli/program.ts',
      'cli/dispatch.ts',
      'cli/routes.ts',
    ],
  },
] as const

export function concernIsolationRule(roots: readonly string[]) {
  return {
    name: 'concern-isolation',
    severity: 'error' as const,
    from: { path: `^(${roots.join('|')})/`, pathNot: ['^cli/'] },
    to: {
      path: `^(?!$1/|shared/)(${roots.join('|')})/`,
    },
  }
}

export function cliCompositionRule(
  roots: readonly string[],
  entries: readonly string[],
  exactPath: (path: string) => string,
) {
  return {
    name: 'cli-imports-only-concern-entries',
    severity: 'error' as const,
    from: { path: '^cli/', pathNot: ['^cli/routes\\.test\\.ts$'] },
    to: {
      path: `^(${roots.filter((root) => root !== 'cli').join('|')})/`,
      pathNot: entries.map(exactPath),
    },
  }
}

export function cliRouteInspectionRule(
  roots: readonly string[],
  exactPath: (path: string) => string,
) {
  return {
    name: 'cli-route-test-inspects-only-owner-programs',
    severity: 'error' as const,
    from: { path: '^cli/routes[.]test[.]ts$' },
    to: {
      path: `^(${roots.filter((root) => root !== 'cli').join('|')})/`,
      pathNot: [exactPath('hub/src/cli-program.ts'), exactPath('orchestrator/src/cli/program.ts')],
    },
  }
}
