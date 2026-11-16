// concern: context-service
/** Pure context-item effects for workflow and lifecycle verbs. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { answerRecordShape } from '../../../shared/record-shape.ts'
import { ANSWER_CONTEXT_KINDS } from './doc-context-write.ts'

type ContextMomentItemKind = (typeof ANSWER_CONTEXT_KINDS)[keyof typeof ANSWER_CONTEXT_KINDS]
export type ContextMomentHolder =
  | { kind: 'task'; value: string }
  | { kind: 'cursor'; value: string }

export type ContextMomentEffect = {
  writes: Array<{
    holder: ContextMomentHolder
    kind: ContextMomentItemKind
    id: string
    source: string
    body: string
    retry: string | null
  }>
  reports: string[]
}

export type ContextMomentInput = {
  holder: ContextMomentHolder | null
  questionId?: number | null
  operatorRuled?: boolean
  text?: string
}

const emptyEffect = (): ContextMomentEffect => ({ writes: [], reports: [] })
const questionSource = (questionId: number) => `q${questionId}`

/** Maps the plain values held by a successful verb to its context mutations. */
export function contextMomentEffect(input: ContextMomentInput): ContextMomentEffect {
  if (!input.questionId || input.text === undefined) return emptyEffect()
  const source = questionSource(input.questionId)
  if (!input.holder)
    return {
      writes: [],
      reports: [`context: did not write ${source}: no task or cursor context holder`],
    }
  const kind = ANSWER_CONTEXT_KINDS[answerRecordShape(Boolean(input.operatorRuled))]
  const item = { kind, id: `${kind}-${source}`, source, body: input.text }
  return {
    writes: [
      {
        holder: input.holder,
        ...item,
        retry: input.holder.kind === 'task' ? contextSetCommand(input.holder.value, item) : null,
      },
    ],
    reports: [],
  }
}

export type ContextMomentOutput = {
  log(line: string): void
  error(line: string): void
}

const shellWord = (value: string) => `'${value.replace(/'/g, "'\\''")}'`

function contextSetCommand(
  taskKey: string,
  item: { kind: string; source: string; id: string; body: string },
): string {
  return (
    `${PLATFORM_SLUG} agent context set --task ${shellWord(taskKey)} --kind ${item.kind} ` +
    `--source ${shellWord(item.source)} --id ${item.id} ${shellWord(item.body)}`
  )
}
