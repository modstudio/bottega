import { REVIEW_SEVERITY_INSTRUCTION } from '../contract/contract.ts'
import { resolveLens } from '../lens/lenses.ts'
import { reviewArtifactBlock } from '../review/review-target.ts'

export function operatorKnowledgeSection(pack: { markdown: string } | null): string {
  return pack?.markdown ? `WHAT THE OPERATOR WANTS YOU TO KNOW\n\n${pack.markdown}` : ''
}

export function initialDispatchPrompt(input: {
  writesJob: boolean
  preamble: string
  infrastructure: string
  operatorKnowledge: string
  taskRulings: string
  spec: string
}): string {
  if (input.writesJob) {
    return [
      input.preamble,
      input.infrastructure ? `\nYOUR WORKTREE'S INFRASTRUCTURE\n\n${input.infrastructure}` : '',
      input.operatorKnowledge ? `\n${input.operatorKnowledge}` : '',
      input.taskRulings ? `\n${input.taskRulings}` : '',
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
  reviewTarget: { branch: string; commit: string; base: string } | null
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
