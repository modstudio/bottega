#!/usr/bin/env bun
// concern: retrieval-search-cli
/** Presents the stable semantic document-search contract. */
import { search } from './index.ts'

function usage(): never {
  throw new Error('usage: bun retrieval/src/search-cli.ts "<query>" [--k N] [--json]')
}

async function main(argv: string[]): Promise<void> {
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
  const output = await search(query, k)
  if (json) {
    console.log(JSON.stringify(output))
    return
  }
  console.log(
    `refresh: ${output.refresh.embedded} embedded, ${output.refresh.deleted} deleted, ${output.refresh.unchanged} unchanged`,
  )
  for (const result of output.results) {
    console.log(
      `${result.scope}/${result.subject ?? '_'}/${result.slug} · ${result.headingPath.join(' > ') || result.title}`,
    )
    console.log(`  ${result.snippet}${result.truncated ? '…' : ''}`)
    console.log(`  embedding ${result.embeddingScore} · rerank ${result.rerankScore}`)
  }
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
