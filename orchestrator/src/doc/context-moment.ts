// concern: context-service
/** Pure context-item effects for workflow and lifecycle verbs. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { taskKeyToken } from '../branch/other-branch-state.ts'
import { LANDED_PULL_REQUEST_EXIT_CODES } from '../pull-request/pr-landed-exit-codes.ts'
import type { ContextItemKind } from './doc-context-write.ts'

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

/** Selects the task context holder for a landed pull request outcome. */
export function pullRequestMergeContextTarget(input: {
  exitCode: number
  headBranch: string
  keyPrefixes: readonly string[]
}): string | null {
  if (!LANDED_PULL_REQUEST_EXIT_CODES.has(input.exitCode)) return null
  return taskKeyToken(input.headBranch, input.keyPrefixes)
}

/** Decides the complete context effect of a landed pull request. */
export function pullRequestMergeContextMomentEffect(input: {
  pullRequestNumber: number
  mergeCommit: string
  items: readonly { id: string; kind: ContextItemKind }[]
}): ContextMomentEffect {
  return {
    writes: [
      {
        kind: 'next-action',
        id: 'next',
        source: 'pr-merge',
        body: `PR ${input.pullRequestNumber} landed as ${input.mergeCommit.slice(0, 12)}.`,
      },
    ],
    drops: input.items
      .filter((item) => item.kind === 'open-question')
      .map((item) => ({ kind: 'open-question' as const, id: item.id })),
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
