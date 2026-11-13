// concern: context-service
/** Pure context-item effects for workflow and lifecycle verbs. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'

type ContextMomentItemKind = 'ruling' | 'position'

export type ContextMomentEffect = {
  writes: Array<{ kind: ContextMomentItemKind; id: string; source: string; body: string }>
}

export type ContextMomentInput = {
  taskKey?: string | null
  questionId?: number | null
  operatorRuled?: boolean
  text?: string
}

const emptyEffect = (): ContextMomentEffect => ({ writes: [] })
const questionSource = (questionId: number) => `q${questionId}`

/** Maps the plain values held by a successful verb to its context mutations. */
export function contextMomentEffect(input: ContextMomentInput): ContextMomentEffect {
  if (!input.taskKey?.trim()) return emptyEffect()
  if (!input.questionId || input.text === undefined) return emptyEffect()
  const source = questionSource(input.questionId)
  const kind = input.operatorRuled ? 'ruling' : 'position'
  return {
    writes: [{ kind, id: `${kind}-${source}`, source, body: input.text }],
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
