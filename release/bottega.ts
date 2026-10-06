import { main as hubMain } from '../hub/src/cli.ts'
import { main as askProxyMain } from '../orchestrator/src/ask/ask-proxy.ts'
import { checkAttributionMain } from '../orchestrator/src/check/check-attribution.ts'
import { checkStrictSchemaMain } from '../orchestrator/src/check/check-strict-schema.ts'
import { main as orchMain } from '../orchestrator/src/cli/orch.ts'
import { main as runExecMain } from '../orchestrator/src/run/exec.ts'
import { main as retrievalSearchMain } from '../retrieval/src/search-cli.ts'
import { installationVersionText } from '../shared/install-root.ts'
import { dispatchBinary } from './dispatch.ts'

const entries = {
  orch: orchMain,
  hub: hubMain,
  runExec: runExecMain,
  askProxy: askProxyMain,
  retrievalSearch: retrievalSearchMain,
  checkAttribution: async (argv: string[]) => checkAttributionMain(argv),
  schemaCheck: async () => checkStrictSchemaMain(),
}

process.exitCode = await dispatchBinary(process.argv.slice(2), process.argv0, entries, () =>
  installationVersionText(import.meta.dir, process.env),
)
