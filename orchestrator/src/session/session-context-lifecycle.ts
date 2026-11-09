// concern: session context lifecycle
/** Applies close-out and resume-consume policy through the context item's owning service. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { dropSessionContextItemsForLifecycle, sessionContextItems } from '../doc/context-service.ts'
import { classifySessionContextItem } from './session-close-out-decision.ts'
import type { SessionErrorItem, SessionProcessItem } from './session-close-out.ts'

export type SessionContextLifecycleReport = {
  items: ReturnType<typeof sessionContextItems>
  mechanical: string[]
  kept: string[]
  process: SessionProcessItem[]
  errors: SessionErrorItem[]
}

function refusedContextProcess(
  session: string,
  item: ReturnType<typeof sessionContextItems>[number],
  dryRun: boolean,
): SessionContextLifecycleReport['process'][number] {
  return {
    item: `context ${item.holder}/${item.id} (${item.kind})`,
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
  const dropItems: typeof report.items = []
  for (const item of report.items) {
    const label = `context ${item.holder}/${item.id} (${item.kind})`
    const action = classifySessionContextItem(item.kind, input.resume)
    if (action === 'keep') report.kept.push(label)
    else if (action === 'refuse')
      report.process.push(refusedContextProcess(input.session, item, input.dryRun))
    else dropItems.push(item)
  }
  const drops = await dropSessionContextItemsForLifecycle({
    session: input.session,
    items: dropItems,
    reason: `session close-out ${input.session}`,
    dryRun: input.dryRun,
  })
  for (const drop of drops) {
    const label = `context ${drop.item.holder}/${drop.item.id} (${drop.item.kind})`
    if (input.dryRun && drop.error === null) report.mechanical.push(`would drop ${label}`)
    else if (drop.removed) report.mechanical.push(`drop ${label}`)
    else if (drop.error)
      report.errors.push({
        item: label,
        detail: drop.error,
        retry: `${PLATFORM_SLUG} session close-out --session ${input.session}`,
      })
  }
  return report
}

export async function consumeSessionContext(input: {
  session: string
  reason: string
  database: Database
}): Promise<{ lines: string[] }> {
  const lines: string[] = []
  const items = sessionContextItems(input.session, input.database)
  for (const item of items) {
    lines.push(`context ${item.holder}/${item.id} ${item.kind} (${item.source}): ${item.body}`)
  }
  for (const drop of await dropSessionContextItemsForLifecycle({
    session: input.session,
    items,
    reason: input.reason,
  })) {
    if (drop.removed)
      lines.push(`dropped context ${drop.item.holder}/${drop.item.id} (${drop.item.kind})`)
    else if (drop.error)
      lines.push(
        `resume context drop failed for ${drop.item.holder}/${drop.item.id} (${drop.item.kind}): ${drop.error}`,
      )
  }
  return { lines }
}
