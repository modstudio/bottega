// concern: shared
/** Pure context-item effects for workflow and lifecycle verbs. */
import { PLATFORM_SLUG } from './brand.ts'

const CONTEXT_MOMENTS = [
  'workflow-next',
  'workflow-rule',
  'workflow-await',
  'question-answer',
  'pr-merge',
] as const
type ContextMoment = (typeof CONTEXT_MOMENTS)[number]
type ContextMomentItemKind = 'next-action' | 'ruling' | 'position' | 'open-question'

export type ContextMomentEffect = {
  writes: Array<{ kind: ContextMomentItemKind; id: string; source: string; body: string }>
  drops: Array<{ kind: ContextMomentItemKind; id: string }>
}

export type ContextMomentInput = {
  moment: ContextMoment
  taskKey?: string | null
  questionId?: number | null
  operatorRuled?: boolean
  text?: string
  cursor?: {
    workflow: string
    number: number
    stepSlug?: string | null
    stepTitle?: string | null
    finished?: boolean
  }
  pullRequest?: { number: number; mergeCommit: string }
  openQuestionIds?: readonly string[]
}

const emptyEffect = (): ContextMomentEffect => ({ writes: [], drops: [] })
const questionSource = (questionId: number) => `q${questionId}`

/** Maps the plain values held by a successful verb to its context mutations. */
export function contextMomentEffect(input: ContextMomentInput): ContextMomentEffect {
  if (!input.taskKey?.trim()) return emptyEffect()
  if (input.moment === 'workflow-next') {
    if (!input.cursor) return emptyEffect()
    const { workflow, number, stepSlug, stepTitle, finished } = input.cursor
    const body = finished
      ? `${workflow} cursor ${number} finished`
      : `${workflow} cursor ${number} at ${stepSlug}: ${stepTitle}`
    const writes: ContextMomentEffect['writes'] = [
      { kind: 'next-action', id: 'next', source: 'workflow-next', body },
    ]
    if (input.text !== undefined && input.questionId) {
      const source = questionSource(input.questionId)
      writes.push({ kind: 'position', id: `position-${source}`, source, body: input.text })
    }
    return { writes, drops: [] }
  }
  if (input.moment === 'pr-merge') {
    if (!input.pullRequest) return emptyEffect()
    return {
      writes: [
        {
          kind: 'next-action',
          id: 'next',
          source: 'pr-merge',
          body: `PR ${input.pullRequest.number} landed as ${input.pullRequest.mergeCommit.slice(0, 12)}.`,
        },
      ],
      drops: (input.openQuestionIds ?? []).map((id) => ({ kind: 'open-question', id })),
    }
  }
  if (!input.questionId || input.text === undefined) return emptyEffect()
  const source = questionSource(input.questionId)
  if (input.moment === 'workflow-await') {
    return {
      writes: [{ kind: 'open-question', id: `open-${source}`, source, body: input.text }],
      drops: [],
    }
  }
  const kind = input.operatorRuled ? 'ruling' : 'position'
  return {
    writes: [{ kind, id: `${kind}-${source}`, source, body: input.text }],
    drops: [{ kind: 'open-question', id: `open-${source}` }],
  }
}

export type ContextMomentOutput = {
  log(line: string): void
  error(line: string): void
}

const shellWord = (value: string) => `'${value.replace(/'/g, "'\\''")}'`

export function contextSetCommand(
  taskKey: string,
  item: { kind: string; source: string; id: string; body: string },
): string {
  return (
    `${PLATFORM_SLUG} agent context set --task ${shellWord(taskKey)} --kind ${item.kind} ` +
    `--source ${shellWord(item.source)} --id ${item.id} ${shellWord(item.body)}`
  )
}

export function contextDropCommand(taskKey: string, id: string): string {
  return `${PLATFORM_SLUG} agent context drop --task ${shellWord(taskKey)} --id ${shellWord(id)}`
}
