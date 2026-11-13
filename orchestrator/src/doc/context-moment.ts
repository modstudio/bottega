// concern: context-service
/** Pure context-item effects for workflow and lifecycle verbs. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'

const CONTEXT_MOMENTS = [
  'workflow-next',
  'workflow-rule',
  'workflow-await',
  'question-answer',
] as const
type ContextMoment = (typeof CONTEXT_MOMENTS)[number]
type ContextMomentItemKind = 'ruling' | 'position'

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
}

const emptyEffect = (): ContextMomentEffect => ({ writes: [], drops: [] })
const questionSource = (questionId: number) => `q${questionId}`

/** Maps the plain values held by a successful verb to its context mutations. */
export function contextMomentEffect(input: ContextMomentInput): ContextMomentEffect {
  if (!input.taskKey?.trim()) return emptyEffect()
  if (input.moment === 'workflow-next') {
    if (input.text === undefined || !input.questionId) return emptyEffect()
    const source = questionSource(input.questionId)
    return {
      writes: [{ kind: 'position', id: `position-${source}`, source, body: input.text }],
      drops: [],
    }
  }
  if (!input.questionId || input.text === undefined) return emptyEffect()
  if (input.moment === 'workflow-await') return emptyEffect()
  const source = questionSource(input.questionId)
  const kind = input.operatorRuled ? 'ruling' : 'position'
  return {
    writes: [{ kind, id: `${kind}-${source}`, source, body: input.text }],
    drops: [],
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
