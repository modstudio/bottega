export const cliConcernEntries = [
  'hub/src/cli.ts',
  'hub/src/cli-program.ts',
  'orchestrator/src/ask/ask-proxy.ts',
  'orchestrator/src/check/check-attribution.ts',
  'orchestrator/src/check/check-strict-schema.ts',
  'orchestrator/src/cli/orch.ts',
  'orchestrator/src/cli/program.ts',
  'orchestrator/src/run/exec.ts',
  'retrieval/src/search-cli.ts',
] as const

export function concernIsolationRule(
  roots: readonly string[],
  exceptions: readonly { to: string }[],
  exactPath: (path: string) => string,
) {
  return {
    name: 'concern-isolation',
    severity: 'error' as const,
    from: { path: `^(${roots.join('|')})/` },
    to: {
      path: `^(?!$1/|shared/)(${roots.join('|')})/`,
      pathNot: exceptions.slice(1).map((entry) => exactPath(entry.to)),
    },
  }
}
