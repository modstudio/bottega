#!/usr/bin/env bun
// concern: retrieval-search-cli
/** Presents the stable semantic document-search contract. */
import { DocSearchOutputSchema } from '../../shared/orch-contract.ts'
import { search } from './search.ts'
import { endpointsFromEnvironment, probeEndpointStatuses } from './services/endpoints.ts'

function usage(): never {
  throw new Error('usage: bun retrieval/src/search-cli.ts "<query>" [--k N] [--json]')
}

export function formatRefreshSummary(refresh: {
  embedded: number
  deleted: number
  unchanged: number
  stale: number
}): string {
  return `refresh: ${refresh.embedded} embedded, ${refresh.deleted} deleted, ${refresh.unchanged} unchanged, ${refresh.stale} stale`
}

async function main(argv: string[]): Promise<void> {
  if (argv.length === 1 && argv[0] === '--check') {
    const statuses = await probeEndpointStatuses(endpointsFromEnvironment(process.env))
    for (const status of statuses) {
      console.log(`${status.kind} ${status.url} ${status.reachable ? 'reachable' : 'unreachable'}`)
    }
    if (statuses.some((status) => !status.reachable)) process.exitCode = 1
    return
  }
  const query = argv[0]
  if (!query || query.startsWith('--')) usage()
  let k = 5
  let json = false
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--json') json = true
    else if (argument === '--k') {
      const value = argv[++index]
      if (!value || !/^\d+$/.test(value)) usage()
      k = Number(value)
    } else usage()
  }
  const output = DocSearchOutputSchema.parse(await search(query, k))
  if (json) {
    console.log(JSON.stringify(output))
    return
  }
  console.log(formatRefreshSummary(output.refresh))
  for (const result of output.results) {
    console.log(
      `${result.scope}/${result.subject ?? '_'}/${result.slug} · ${result.headingPath.join(' > ') || result.title}`,
    )
    console.log(`  ${result.snippet}${result.truncated ? '…' : ''}`)
    console.log(`  embedding ${result.embeddingScore} · rerank ${result.rerankScore}`)
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
