import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { REVIEW_SEVERITY_INSTRUCTION } from '../contract/contract.ts'
import type { TaskTextRead } from '../dispatch/task-key-lookup.ts'
import { resolveLens } from '../lens/lenses.ts'
import { type ResolvedReviewTarget, reviewArtifactBlock } from '../review/review-target.ts'

export const TASK_TEXT_MAX_BYTES = 16 * 1024

function fitUtf8(value: string, bytes: number): string {
  const encoded = Buffer.from(value)
  if (encoded.byteLength <= bytes) return value
  return encoded
    .subarray(0, bytes)
    .toString('utf8')
    .replace(/\uFFFD$/u, '')
}

export function taskTextReadRemedy(input: {
  key: string
  project: string
  getTool: string
  hub: boolean
}): string {
  return input.hub
    ? `${PLATFORM_SLUG} task show ${input.key} --project ${input.project}`
    : input.getTool
}

export function boundTaskText(value: string, remedy: string): string {
  if (Buffer.byteLength(value) <= TASK_TEXT_MAX_BYTES) return value
  const suffix = `\n\nTask text was truncated; read the full task with ${remedy}.`
  return `${fitUtf8(value, TASK_TEXT_MAX_BYTES - Buffer.byteLength(suffix))}${suffix}`
}

export function taskTextSection(input: {
  task: TaskTextRead
  key: string
  project: string
  getTool: string
  hub: boolean
}): string {
  if (!input.task.available) {
    return `TASK TEXT: ${input.key} could not be read: ${input.task.reason}`
  }
  const full = [
    `TASK TEXT: ${input.task.key} — ${input.task.title}`,
    input.task.body.trim(),
    ...input.task.comments.map((comment) => `Task comment: ${comment}`),
  ]
    .filter(Boolean)
    .join('\n\n')
  return boundTaskText(full, taskTextReadRemedy(input))
}

export function operatorKnowledgeSection(pack: { markdown: string } | null): string {
  return pack?.markdown ? `WHAT THE OPERATOR WANTS YOU TO KNOW\n\n${pack.markdown}` : ''
}

export function initialDispatchPrompt(input: {
  writesJob: boolean
  preamble: string
  infrastructure: string
  operatorKnowledge: string
  taskRulings: string
  taskText: string
  spec: string
}): string {
  if (input.writesJob) {
    return [
      input.preamble,
      input.infrastructure ? `\nYOUR WORKTREE'S INFRASTRUCTURE\n\n${input.infrastructure}` : '',
      input.operatorKnowledge ? `\n${input.operatorKnowledge}` : '',
      input.taskRulings ? `\n${input.taskRulings}` : '',
      input.taskText ? `\n${input.taskText}` : '',
      `\n---\n\nTHE SPEC\n\n${input.spec}`,
    ]
      .filter(Boolean)
      .join('\n')
  }
  return [
    input.preamble,
    input.infrastructure ? `YOUR WORKTREE'S INFRASTRUCTURE\n\n${input.infrastructure}` : '',
    input.operatorKnowledge,
    input.taskRulings,
    input.taskText,
    `---\n\nTHE SPEC\n\n${input.spec}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function checksReviewedCommit(findings: boolean, readsRepo: boolean): boolean {
  return findings && readsRepo
}

export function bindReviewInstructions(input: {
  prompt: string
  findings: boolean
  firstTurn: boolean
  reviewTarget: ResolvedReviewTarget | null
  readsRepo: boolean
  checkoutCommit: string | null
  coverageBase: string | null
  lens: string | undefined
  repo: string | null
}): string {
  if (!input.findings || !input.firstTurn) return input.prompt
  let prompt = `${REVIEW_SEVERITY_INSTRUCTION}\n\n${input.prompt}`
  const artifact =
    input.reviewTarget ??
    (input.readsRepo && input.checkoutCommit && input.coverageBase
      ? { commit: input.checkoutCommit, base: input.coverageBase }
      : null)
  if (artifact) prompt += `\n\n${reviewArtifactBlock(artifact)}`
  const resolvedLens = resolveLens(input.lens!, input.repo)
  if (resolvedLens?.body) return `${prompt}\n\n${resolvedLens.body}`
  if (resolvedLens) return prompt
  console.error(`lens ${input.lens}: no catalogue row; dispatching the free-form lens unchanged`)
  return prompt
}
