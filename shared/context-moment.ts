// concern: shared
/** Pure context-item effects and the remaining legacy prompt policy. */
import { PLATFORM_SLUG } from './brand.ts'

const CONTEXT_MOMENTS = [
  'workflow-next',
  'workflow-rule',
  'workflow-await',
  'question-answer',
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

type LegacyContextMoment = 'pr-merge' | 'task-close'
type LegacyContextMomentKind = 'next-action'

export type ContextMomentWrite = {
  holder: string
  kind: LegacyContextMomentKind
  command: string
  write: string
  line: string
}

export type ContextMomentOutput = {
  log(line: string): void
  error(line: string): void
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** Keeps the existing prompt for the lifecycle verbs owned by later work. */
export function contextMomentWrite(input: {
  moment: LegacyContextMoment
  taskKey?: string | null
}): ContextMomentWrite | null {
  const holder = input.taskKey?.trim()
  if (!holder) return null
  const kind = 'next-action'
  const command =
    `${PLATFORM_SLUG} agent context set --task ${shellQuote(holder)} --kind ${kind} ` +
    `--source ${shellQuote(input.moment)} --id next ${shellQuote('<text>')}`
  const write = 'revise next-action'
  return { holder, kind, command, write, line: `context: ${write} on ${holder} (${command})` }
}

/** Keeps JSON stdout machine-readable while making the prompt the trailing human output. */
export function emitContextMoment(
  write: ContextMomentWrite | null,
  json: boolean,
  output: ContextMomentOutput = { log: console.log, error: console.error },
): void {
  if (!write) return
  if (json) output.error(write.line)
  else output.log(write.line)
}
