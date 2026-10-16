import { installationVersionText } from '../shared/install-root.ts'
import { dispatchBinary } from './dispatch.ts'

// Each entry loads its owner only when called, so a call to one program never pays for another.
const entries = {
  orch: async (argv: string[]) => (await import('../orchestrator/src/cli/orch.ts')).main(argv),
  hub: async (argv: string[]) => (await import('../hub/src/cli.ts')).main(argv),
  orchOutbox: async () => (await import('../orchestrator/src/cli/orch.ts')).outboxEntries(),
  hubOutbox: async () => (await import('../hub/src/cli.ts')).outboxEntries(),
  hubOutboxSummaryLines: async (rows: readonly Record<string, unknown>[]) =>
    (await import('../hub/src/cli.ts')).outboxSummaryLines(rows),
  runExec: async (argv: string[]) => (await import('../orchestrator/src/run/exec.ts')).main(argv),
  askProxy: async (argv: string[]) =>
    (await import('../orchestrator/src/ask/ask-proxy.ts')).main(argv),
  retrievalSearch: async (argv: string[]) =>
    (await import('../retrieval/src/search-cli.ts')).main(argv),
  checkAttribution: async (argv: string[]) =>
    (await import('../orchestrator/src/check/check-attribution.ts')).checkAttributionMain(argv),
  schemaCheck: async () =>
    (await import('../orchestrator/src/check/check-strict-schema.ts')).checkStrictSchemaMain(),
}

process.exitCode = await dispatchBinary(process.argv.slice(2), process.argv0, entries, () =>
  installationVersionText(import.meta.dir, process.env),
)
