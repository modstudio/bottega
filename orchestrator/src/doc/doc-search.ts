// concern: doc-search-adapter
/** Spawns retrieval semantic search and validates its stable JSON contract. */
import { assetPath } from '../../../shared/install-root.ts'

export type DocSearchOutput = {
  query: string
  k: number
  contract: { model: string; dimension: number; instructionVersion: string }
  refresh: { embedded: number; deleted: number; unchanged: number }
  results: Array<{
    scope: string
    subject: string | null
    slug: string
    title: string
    headingPath: string[]
    snippet: string
    truncated: boolean
    embeddingScore: number
    rerankScore: number
  }>
}

type Runner = (argv: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>

const RETRIEVAL_SEARCH = assetPath('bin', 'retrieval-search')

async function runRetrieval(argv: string[]): Promise<{
  stdout: string
  stderr: string
  exitCode: number
}> {
  const child = Bun.spawn([RETRIEVAL_SEARCH, ...argv], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

function validScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function parseDocSearchOutput(stdout: string): DocSearchOutput {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch (error) {
    throw new Error(
      `retrieval search returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!value || typeof value !== 'object') throw new Error('retrieval search returned no object')
  const output = value as Record<string, unknown>
  const contract = output.contract as Record<string, unknown> | undefined
  const refresh = output.refresh as Record<string, unknown> | undefined
  const results = output.results
  const validResult = (candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object') return false
    const row = candidate as Record<string, unknown>
    return (
      typeof row.scope === 'string' &&
      (typeof row.subject === 'string' || row.subject === null) &&
      typeof row.slug === 'string' &&
      typeof row.title === 'string' &&
      Array.isArray(row.headingPath) &&
      row.headingPath.every((heading) => typeof heading === 'string') &&
      typeof row.snippet === 'string' &&
      typeof row.truncated === 'boolean' &&
      validScore(row.embeddingScore) &&
      validScore(row.rerankScore)
    )
  }
  if (
    typeof output.query !== 'string' ||
    !Number.isInteger(output.k) ||
    !contract ||
    typeof contract.model !== 'string' ||
    !Number.isInteger(contract.dimension) ||
    typeof contract.instructionVersion !== 'string' ||
    !refresh ||
    !Number.isInteger(refresh.embedded) ||
    !Number.isInteger(refresh.deleted) ||
    !Number.isInteger(refresh.unchanged) ||
    !Array.isArray(results) ||
    !results.every(validResult)
  ) {
    throw new Error('retrieval search returned an invalid JSON contract')
  }
  return value as DocSearchOutput
}

export async function searchDocs(query: string, k: number, runner: Runner = runRetrieval) {
  const result = await runner([query, '--k', String(k), '--json'])
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `retrieval search exited ${result.exitCode}`,
    )
  }
  return parseDocSearchOutput(result.stdout)
}
