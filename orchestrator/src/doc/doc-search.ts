// concern: doc-search-adapter
/** Spawns retrieval semantic search and validates its stable JSON contract. */

import { DocSearchOutputSchema } from '../../../shared/orch-contract.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'

type Runner = (argv: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>

async function runRetrieval(argv: string[]): Promise<{
  stdout: string
  stderr: string
  exitCode: number
}> {
  const child = Bun.spawn([...bottegaEntryArgv('retrieval-search'), ...argv], {
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

function parseDocSearchOutput(stdout: string) {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch (error) {
    throw new Error(
      `retrieval search returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const parsed = DocSearchOutputSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error('retrieval search returned an invalid JSON contract')
  }
  return parsed.data
}

export async function checkRetrieval(runner: Runner = runRetrieval) {
  return runner(['--check'])
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
