// concern: evidence
/** Owns fix-defect, note, state, and search command behavior. Must not know CLI grammar. */
import { db } from './db.ts'
import { dispatchFiledIssues, waitingFiledIssues } from './issue-dispatch.ts'
import { fileNote } from './mcp.ts'
import { searchRecords } from './search.ts'
import { state } from './serve.ts'

type Presentation = { log(value: string): void }

export async function fixDefectCommand(
  key: string | undefined,
  options: { waiting: boolean; json: boolean },
  presentation: Presentation,
): Promise<void> {
  if (options.waiting) {
    const waiting = await waitingFiledIssues()
    if (options.json) presentation.log(JSON.stringify(waiting))
    else
      for (const issue of waiting) presentation.log(`${issue.key}  ${issue.title ?? ''}`.trimEnd())
    return
  }
  if (options.json) throw new Error('--json requires --waiting')
  await dispatchFiledIssues(key)
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
