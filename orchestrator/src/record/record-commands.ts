// concern: evidence
/** Owns fix-defect, note, state, and search command behavior. Must not know CLI grammar. */
import { db } from '../database/db.ts'
import { dispatchFiledIssues, filedIssueQueueState } from '../issue/issue-dispatch.ts'
import { fileNote } from '../mcp/hub-notes.ts'
import { projectAt } from '../project/projects.ts'
import { searchRecords } from '../search.ts'
import { state } from '../state/serve.ts'

type Presentation = { log(value: string): void; setExitCode(code: number): void }

async function fixDefectWaitingResult(cwd?: string): Promise<{
  state: Awaited<ReturnType<typeof filedIssueQueueState>>
  json: string
}> {
  if (cwd === undefined) {
    const state = await filedIssueQueueState()
    return { state, json: JSON.stringify(state) }
  }
  const project = projectAt(cwd)
  const state = await filedIssueQueueState(project?.name ?? null)
  return {
    state,
    json: JSON.stringify({
      cwd_registered: project !== null,
      project: project?.name ?? null,
      state,
    }),
  }
}

export async function fixDefectCommand(
  key: string | undefined,
  options: { waiting: boolean; json: boolean; cwd?: string },
  presentation: Presentation,
): Promise<void> {
  if (options.waiting) {
    const result = await fixDefectWaitingResult(options.cwd)
    if (options.json) presentation.log(result.json)
    else
      for (const issue of result.state.waiting)
        presentation.log(`${issue.key}  ${issue.title ?? ''}`.trimEnd())
    return
  }
  if (options.json) throw new Error('--json requires --waiting')
  if (options.cwd !== undefined) throw new Error('--cwd requires --waiting')
  if (await dispatchFiledIssues(key)) presentation.setExitCode(1)
}

export async function noteCommand(
  text: string,
  options: { sameAs?: number; new: boolean },
  presentation: Presentation,
): Promise<void> {
  const result = await fileNote({
    text,
    ...(options.sameAs ? { same_as: options.sameAs } : {}),
    new: options.new,
  })
  presentation.log(result.output)
}

export function stateCommand(days: number | null, presentation: Presentation): void {
  presentation.log(JSON.stringify(state(days)))
}

export function serveCommand(presentation: {
  error(value: string): void
  setExitCode(code: number): void
}): void {
  presentation.error('the dashboard moved: run `hub serve` (http://127.0.0.1:7778)')
  presentation.setExitCode(1)
}

export function searchCommand(
  query: string,
  options: { limit: number; full: boolean; json: boolean },
  presentation: Presentation,
): void {
  const found = searchRecords(db(), query, options.limit, options.full)
  if (options.json) {
    presentation.log(JSON.stringify(found))
    return
  }
  renderSearchResults(found, presentation)
  if (found.unavailable_outputs)
    presentation.log(
      `\n${found.unavailable_outputs} saved run output${found.unavailable_outputs === 1 ? ' is' : 's are'} no longer available and could not be searched`,
    )
}

function renderSearchResults(
  found: ReturnType<typeof searchRecords>,
  presentation: Presentation,
): void {
  if (!found.results.length) {
    presentation.log(`no record matches for "${found.query}"`)
    return
  }
  for (const result of found.results) {
    const task = result.task_key ? ` · ${result.task_key}` : ''
    presentation.log(
      `${result.source} ${result.record_id} · run ${result.run_id}${task} · ${result.match}\n${result.content === undefined ? `  ${result.snippet}` : result.content}`,
    )
  }
  if (found.truncated) presentation.log('\nmore matches omitted; increase --limit to see them')
}
