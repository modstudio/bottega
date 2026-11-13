// concern: doc-context-write
/** Pure write policy for one structured context item. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
export {
  CONTEXT_ITEM_KINDS,
  type ContextItemKind,
} from '../../../shared/context-item-vocabulary.ts'
import {
  CONTEXT_ITEM_KINDS,
  type ContextItemKind,
} from '../../../shared/context-item-vocabulary.ts'
import {
  type ContextRecordName,
  NEXT_ACTION_MAX_CHARS,
  OPEN_QUESTION_MAX_CHARS,
  RULING_MAX_CHARS,
  recordShapeRefusal,
} from '../../../shared/record-shape.ts'
import type { HubTaskReference } from '../workflow/workflow-task-reference.ts'

export type ContextTaskIdentity = Pick<
  HubTaskReference,
  'key' | 'record_id' | 'project' | 'parent_key'
>

export const CONTEXT_ITEM_MAX_CHARS = {
  ruling: RULING_MAX_CHARS,
  position: 800,
  fact: 800,
  'open-question': OPEN_QUESTION_MAX_CHARS,
  pointer: 400,
  'next-action': NEXT_ACTION_MAX_CHARS,
} as const satisfies Record<ContextItemKind, number>

const CONTEXT_ITEM_RECORD_NAMES = {
  ruling: 'ruling',
  'open-question': 'open question',
  'next-action': 'next action',
} as const satisfies Partial<Record<ContextItemKind, ContextRecordName>>

/** A ruling names where Shmuel Barkin gave it: a question, a board message, or the chat on a date. */
const RULING_SOURCE = /^(q\d+|board:[0-9a-f-]{36}|chat \d{4}-\d{2}-\d{2})$/

export type ContextProfile = 'epic' | 'task' | 'session'
export type ContextItem = {
  holder: string
  id: string
  kind: ContextItemKind
  source: string
  body: string
  questionNumber?: number | null
  target?: string | null
}
export type ContextWriteFacts = {
  profile: ContextProfile
  siblings: ContextItem[]
  related: ContextItem[]
  pointerRefusal: string | null
  claimedTask: string | null
}

/** A policy refusal is distinct from a storage failure that can be retried unchanged. */
export class ContextWriteRefusalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContextWriteRefusalError'
  }
}

const PROFILE = {
  epic: { allowed: CONTEXT_ITEM_KINDS, required: ['next-action'] },
  task: { allowed: CONTEXT_ITEM_KINDS, required: ['next-action'] },
  session: { allowed: CONTEXT_ITEM_KINDS, required: [] },
} as const satisfies Record<
  ContextProfile,
  { allowed: readonly ContextItemKind[]; required: readonly ContextItemKind[] }
>

function normalizeContextBody(body: string): string {
  return body.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function contextWriteRefusal(item: ContextItem, facts: ContextWriteFacts): string | null {
  const address = `context item ${item.id}`
  const profile = PROFILE[facts.profile]
  if (!(profile.allowed as readonly ContextItemKind[]).includes(item.kind)) {
    return `${address} refused: ${facts.profile} profile does not allow kind ${item.kind}`
  }
  const shape = contextItemShapeRefusal(item)
  if (shape) return shape
  if (
    facts.profile === 'session' &&
    facts.claimedTask &&
    ['ruling', 'open-question'].includes(item.kind)
  ) {
    return `${address} refused: task-level ${item.kind} written to a session; write it with ${PLATFORM_SLUG} agent context set --task ${facts.claimedTask}`
  }
  if (item.kind === 'pointer' && facts.pointerRefusal) {
    return `${address} refused: ${facts.pointerRefusal}`
  }
  const existingNext =
    item.kind === 'next-action'
      ? facts.siblings.find((sibling) => sibling.kind === 'next-action' && sibling.id !== item.id)
      : undefined
  if (existingNext) {
    return `${address} refused: holder ${item.holder} allows at most one next-action item; revise existing item ${item.holder}/${existingNext.id}`
  }
  const normalized = normalizeContextBody(item.body)
  for (const other of facts.related) {
    const related = normalizeContextBody(other.body)
    if (normalized === related || (normalized.length >= 80 && related.includes(normalized))) {
      return `${address} refused: restates ${other.holder}/${other.id}; point at that item instead`
    }
  }
  return null
}

/** The rules one item obeys without facts about its holder, so the hosted record applies them too. */
export function contextItemShapeRefusal(item: ContextItem): string | null {
  const metadata = contextItemMetadataRefusal(item)
  if (metadata) return metadata
  const record = CONTEXT_ITEM_RECORD_NAMES[item.kind as keyof typeof CONTEXT_ITEM_RECORD_NAMES]
  if (record !== undefined) {
    const refusal = recordShapeRefusal(record, item.body)
    return refusal === null ? null : `context item ${item.id} refused: ${refusal}`
  }
  return contextItemLengthRefusal(item)
}

function contextItemMetadataRefusal(item: ContextItem): string | null {
  const address = `context item ${item.id}`
  if (!item.source.trim()) return `${address} refused: every item requires a non-empty source`
  if (item.kind === 'ruling' && !RULING_SOURCE.test(item.source.trim())) {
    return `${address} refused: a ruling source names where it was given; write --source as q<number>, board:<id> or chat <YYYY-MM-DD>`
  }
  if (item.kind === 'ruling' && !item.body.trim()) {
    return `${address} refused: a ruling requires a non-empty body`
  }
  if (item.questionNumber !== undefined) {
    const question = /^q(\d+)$/.exec(item.source.trim())
    const expectedQuestionNumber =
      ['ruling', 'position'].includes(item.kind) && question ? Number(question[1]) : null
    if (item.questionNumber !== expectedQuestionNumber) {
      return `${address} refused: question number does not match kind and source`
    }
  }
  const targetRefusal = contextItemTargetRefusal(item)
  if (targetRefusal) return `${address} refused: ${targetRefusal}`
  return null
}

function contextItemTargetRefusal(item: ContextItem): string | null {
  if (item.target === undefined) return null
  if (item.kind !== 'pointer') {
    return item.target == null ? null : 'target is only valid for a pointer'
  }
  const pointer = item.body.trim()
  if (!item.target) return 'a pointer requires its resolved target'
  const pr = /^#?(\d+)$/.exec(pointer)
  if (pr) return item.target === pr[1] ? null : 'target does not match the pointer body'
  if (/^[0-9a-f]{4,39}$/i.test(pointer)) {
    return /^[0-9a-f]{40}$/i.test(item.target) && item.target.startsWith(pointer)
      ? null
      : 'target does not match the resolved commit'
  }
  return item.target === pointer ? null : 'target does not match the pointer body'
}

function contextItemLengthRefusal(item: ContextItem): string | null {
  if (item.body.length > CONTEXT_ITEM_MAX_CHARS[item.kind]) {
    const address = `context item ${item.id}`
    return `${address} refused: ${item.kind} limit is ${CONTEXT_ITEM_MAX_CHARS[item.kind]} characters`
  }
  return null
}

/** Only the session a session holder names may write or drop its items. */
export function holderOwnershipRefusal(
  holder: string,
  caller: string | null,
  id: string,
): string | null {
  if (!holder.startsWith('session:')) return null
  const owner = holder.slice('session:'.length)
  return owner === caller
    ? null
    : `context item ${id} refused: only owning session ${owner} may write ${holder}`
}

export function contextDropRefusal(
  item: ContextItem,
  siblings: ContextItem[],
  profile: ContextProfile,
) {
  const required = PROFILE[profile].required as readonly ContextItemKind[]
  if (
    required.includes(item.kind) &&
    siblings.filter((row) => row.kind === item.kind).length === 1
  ) {
    return `context item ${item.id} refused: cannot remove the last required ${item.kind} item`
  }
  return null
}

export function missingContextKinds(
  items: ContextItem[],
  profile: ContextProfile,
): ContextItemKind[] {
  return PROFILE[profile].required.filter(
    (kind) => !items.some((item) => item.kind === kind),
  ) as ContextItemKind[]
}
