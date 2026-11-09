// concern: shared
/** Pure context-write prompt policy shared by command owners. */
import { PLATFORM_SLUG } from './brand.ts'

export const CONTEXT_MOMENTS = [
  'workflow-next',
  'workflow-rule',
  'workflow-await',
  'question-answer',
  'run-start',
  'pr-merge',
  'task-close',
] as const
export type ContextMoment = (typeof CONTEXT_MOMENTS)[number]
type ContextMomentKind = 'next-action' | 'ruling' | 'open-question'

export type ContextMomentWrite = {
  holder: string
  kind: ContextMomentKind
  command: string
  write: string
  line: string
}

export type ContextMomentOutput = {
  log(line: string): void
  error(line: string): void
}

const MOMENT_KIND: Record<ContextMoment, ContextMomentKind> = {
  'workflow-next': 'next-action',
  'workflow-rule': 'ruling',
  'workflow-await': 'open-question',
  'question-answer': 'ruling',
  'run-start': 'next-action',
  'pr-merge': 'next-action',
  'task-close': 'next-action',
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** Maps one successful task-keyed verb to the context write it should prompt. */
export function contextMomentWrite(input: {
  moment: ContextMoment
  taskKey?: string | null
  questionId?: number | null
}): ContextMomentWrite | null {
  const holder = input.taskKey?.trim()
  if (!holder) return null
  const kind = MOMENT_KIND[input.moment]
  if ((kind === 'ruling' || kind === 'open-question') && !input.questionId) return null
  const question = input.questionId ? `q${input.questionId}` : null
  const id =
    kind === 'next-action' ? 'next' : kind === 'ruling' ? `ruling-${question}` : `open-${question}`
  const source = question ?? input.moment
  const command =
    `${PLATFORM_SLUG} agent context set --task ${shellQuote(holder)} --kind ${kind} ` +
    `--source ${shellQuote(source)} --id ${id} ${shellQuote('<text>')}`
  const write = kind === 'next-action' ? 'revise next-action' : `write ${kind}`
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
