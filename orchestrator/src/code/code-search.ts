// concern: code-search-adapter
/** Applies project policy, spawns retrieval code search, and validates its JSON contract. */

import { CodeSearchOutputSchema } from '../../../shared/orch-contract.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import type { Project } from '../project/projects.ts'

type Runner = (argv: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>

async function runRetrieval(argv: string[]) {
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

export async function searchProjectCode(
  project: Project,
  checkoutPath: string,
  query: string,
  k: number,
  runner: Runner = runRetrieval,
) {
  if (project.settings.search?.code !== true) {
    throw new Error(
      `project ${project.name} has not opted into code search; set settings.search.code to true`,
    )
  }
  const result = await runner([
    query,
    '--code',
    '--project',
    checkoutPath,
    '--k',
    String(k),
    '--json',
  ])
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `retrieval search exited ${result.exitCode}`,
    )
  }
  let value: unknown
  try {
    value = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(
      `retrieval search returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const parsed = CodeSearchOutputSchema.safeParse(value)
  if (!parsed.success) throw new Error('retrieval search returned an invalid code JSON contract')
  return parsed.data
}
