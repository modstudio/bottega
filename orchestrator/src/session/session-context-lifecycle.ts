// concern: session context lifecycle
/** Applies close-out and resume-consume policy through the context item's owning service. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { dropSessionContextItemsForLifecycle, sessionContextItems } from '../doc/context-service.ts'
import { classifySessionContextItem } from './session-close-out-decision.ts'
import type { SessionErrorLine, SessionProcessLine } from './session-close-out-report.ts'

export type SessionContextLifecycleReport = {
  items: Awaited<ReturnType<typeof sessionContextItems>>
  mechanical: string[]
  kept: string[]
  process: SessionProcessLine[]
  errors: SessionErrorLine[]
}

function refusedContextProcess(
  session: string,
  item: Awaited<ReturnType<typeof sessionContextItems>>[number],
  dryRun: boolean,
): SessionContextLifecycleReport['process'][number] {
  return {
    item: `context ${item.holder}/${item.id} (${item.kind})`,
    reason: `${dryRun ? 'would refuse close-out because' : 'session close-out refused because'} ${item.kind} must move to a task or epic`,
    evidence: item.body.split(/\r?\n/, 1)[0] ?? '',
    remedy: `${PLATFORM_SLUG} agent context set --task <KEY> --kind ${item.kind} --id ${item.id} --source ${JSON.stringify(item.source)} ${JSON.stringify(item.body)} && ${PLATFORM_SLUG} agent context drop --session ${session} --id ${item.id}`,
  }
}

function remainingContextProcess(
  session: string,
  items: Awaited<ReturnType<typeof sessionContextItems>>,
): SessionProcessLine | null {
  const remaining = items.filter(
    (item) => classifySessionContextItem(item.kind, false) !== 'refuse',
  )
  if (!remaining.length) return null
  return {
    item: `context session:${session}`,
    reason: `session close-out left ${remaining.length} context ${remaining.length === 1 ? 'item' : 'items'} on the session holder`,
    evidence: remaining.map((item) => `${item.id} (${item.kind})`).join(', '),
    remedy: `${PLATFORM_SLUG} agent context show --session ${session}`,
  }
}

function contextDropMechanicalLine(
  drop: Awaited<ReturnType<typeof dropSessionContextItemsForLifecycle>>[number],
  label: string,
): string | null {
  if (drop.outcome === 'would-drop') return `would drop ${label}`
  if (drop.outcome === 'dropped') return `drop ${label}`
  if (drop.outcome === 'already-absent') return `already absent ${label}`
  return null
}

export async function closeOutSessionContext(input: {
  session: string
  dryRun: boolean
  resume: boolean
  database: Database
}): Promise<SessionContextLifecycleReport> {
  const report: SessionContextLifecycleReport = {
    items: await sessionContextItems(input.session, input.database),
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
    const mechanical = contextDropMechanicalLine(drop, label)
    if (mechanical) report.mechanical.push(mechanical)
    else if (drop.error)
      report.errors.push({
        item: label,
        detail: drop.error,
        retry: `${PLATFORM_SLUG} session close-out --session ${input.session}`,
      })
  }
  if (!input.dryRun && !input.resume) {
    const process = remainingContextProcess(
      input.session,
      await sessionContextItems(input.session, input.database),
    )
    if (process) report.process.push(process)
  }
  return report
}

export async function consumeSessionContext(input: {
  session: string
  reason: string
  database: Database
}): Promise<{ lines: string[] }> {
  const lines: string[] = []
  const items = await sessionContextItems(input.session, input.database)
  for (const item of items) {
    lines.push(`context ${item.holder}/${item.id} ${item.kind} (${item.source}): ${item.body}`)
  }
  for (const drop of await dropSessionContextItemsForLifecycle({
    session: input.session,
    items,
    reason: input.reason,
  })) {
    if (drop.outcome === 'dropped')
      lines.push(`dropped context ${drop.item.holder}/${drop.item.id} (${drop.item.kind})`)
    else if (drop.outcome === 'already-absent')
      lines.push(`context already absent ${drop.item.holder}/${drop.item.id} (${drop.item.kind})`)
    else if (drop.outcome === 'failed' && drop.error)
      lines.push(
        `resume context drop failed for ${drop.item.holder}/${drop.item.id} (${drop.item.kind}): ${drop.error}`,
      )
  }
  return { lines }
}

export async function keptSessionContext(input: {
  session: string
  remedy: string
  database: Database
}): Promise<{ lines: string[] }> {
  return {
    lines: (await sessionContextItems(input.session, input.database)).map(
      (item) =>
        `kept context ${item.holder}/${item.id} (${item.kind}): run ${input.remedy} to finish the handoff`,
    ),
  }
}
