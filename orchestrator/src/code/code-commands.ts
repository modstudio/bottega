// concern: code-commands
/** Resolves project code-search requests and presents their results. */

import { projectAt, projectByName } from '../project/projects.ts'
import { searchProjectCode } from './code-search.ts'

type Flags = { has(name: string): boolean; flag(name: string): string | undefined }

export async function codeSearchCommand(
  query: string | undefined,
  flags: Flags,
  presentation: { cwd(): string; log(...values: unknown[]): void },
): Promise<void> {
  if (!query) throw new Error('orch code search "<query>" [--project P] [--k N] [--json]')
  const projectName = flags.flag('project')
  const project = projectName ? projectByName(projectName) : projectAt(presentation.cwd())
  if (!project) {
    throw new Error(
      projectName
        ? `no project "${projectName}"`
        : 'the working directory is not inside a registered project; pass --project P',
    )
  }
  const rawK = flags.flag('k') ?? '5'
  if (!/^\d+$/.test(rawK) || Number(rawK) < 1) throw new Error('--k must be a positive integer')
  const output = await searchProjectCode(project, query, Number(rawK))
  if (flags.has('json')) {
    presentation.log(JSON.stringify(output))
    return
  }
  for (const result of output.results) {
    presentation.log(`${result.path}:${result.startLine}-${result.endLine}`)
    presentation.log(`  ${result.snippet}${result.truncated ? '…' : ''}`)
  }
}
