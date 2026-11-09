// concern: session context lifecycle
/** Applies close-out and resume-consume policy through the context item's owning service. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { dropSessionContextItemForLifecycle, sessionContextItems } from '../doc/context-service.ts'
import { classifySessionContextItem } from './session-close-out-decision.ts'

export type SessionContextLifecycleReport = {
  items: ReturnType<typeof sessionContextItems>
  mechanical: string[]
  kept: string[]
  process: { item: string; reason: string; evidence: string; remedy: string }[]
  errors: { item: string; detail: string; retry: string }[]
}

function refusedContextProcess(
  session: string,
  item: ReturnType<typeof sessionContextItems>[number],
  dryRun: boolean,
): SessionContextLifecycleReport['process'][number] {
  return {
    item: `context ${item.holder}/${item.id}`,
    reason: `${dryRun ? 'would refuse close-out because' : 'session close-out refused because'} ${item.kind} must move to a task or epic`,
    evidence: item.body.split(/\r?\n/, 1)[0] ?? '',
    remedy: `${PLATFORM_SLUG} agent context set --task <KEY> --kind ${item.kind} --id ${item.id} --source ${JSON.stringify(item.source)} ${JSON.stringify(item.body)} && ${PLATFORM_SLUG} agent context drop --session ${session} --id ${item.id}`,
  }
}

export async function closeOutSessionContext(input: {
  session: string
  dryRun: boolean
  resume: boolean
  database: Database
}): Promise<SessionContextLifecycleReport> {
  const report: SessionContextLifecycleReport = {
    items: sessionContextItems(input.session, input.database),
    mechanical: [],
    kept: [],
    process: [],
    errors: [],
  }
  for (const item of report.items) {
    const label = `context ${item.holder}/${item.id}`
    const action = classifySessionContextItem(item.kind, input.resume)
    if (action === 'keep') report.kept.push(label)
    else if (action === 'refuse')
      report.process.push(refusedContextProcess(input.session, item, input.dryRun))
    else if (input.dryRun) report.mechanical.push(`would drop ${label}`)
    else {
      try {
        await dropSessionContextItemForLifecycle({
          session: input.session,
          id: item.id,
          expectedRevision: item.revision ?? undefined,
          reason: `session close-out ${input.session}`,
        })
        report.mechanical.push(`drop ${label}`)
      } catch (cause) {
        report.errors.push({
          item: label,
          detail: cause instanceof Error ? cause.message : String(cause),
          retry: `${PLATFORM_SLUG} session close-out --session ${input.session}`,
        })
      }
    }
  }
  return report
}

export async function consumeSessionContext(input: {
  session: string
  reason: string
  database: Database
}): Promise<{ lines: string[]; error: string | null }> {
  const lines: string[] = []
  for (const item of sessionContextItems(input.session, input.database)) {
    lines.push(`context ${item.holder}/${item.id} ${item.kind} (${item.source}): ${item.body}`)
    try {
      await dropSessionContextItemForLifecycle({
        session: input.session,
        id: item.id,
        expectedRevision: item.revision ?? undefined,
        reason: input.reason,
      })
    } catch (error) {
      return {
        lines,
        error: `resume context drop failed for ${item.holder}/${item.id}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
  return { lines, error: null }
}
