import { REVIEW_SEVERITY_INSTRUCTION } from '../contract/contract.ts'
import { resolveLens } from '../lens/lenses.ts'
import { reviewArtifactBlock } from '../review/review-target.ts'

export function operatorKnowledgeSection(pack: { markdown: string } | null): string {
  return pack?.markdown ? `WHAT THE OPERATOR WANTS YOU TO KNOW\n\n${pack.markdown}` : ''
}

export function bindReviewInstructions(input: {
  prompt: string
  findings: boolean
  firstTurn: boolean
  reviewTarget: { branch: string; commit: string; base: string } | null
  lens: string | undefined
  repo: string | null
}): string {
  if (!input.findings || !input.firstTurn) return input.prompt
  let prompt = `${REVIEW_SEVERITY_INSTRUCTION}\n\n${input.prompt}`
  if (input.reviewTarget) prompt += `\n\n${reviewArtifactBlock(input.reviewTarget)}`
  const resolvedLens = resolveLens(input.lens!, input.repo)
  if (resolvedLens) return `${prompt}\n\n${resolvedLens.body}`
  console.error(`lens ${input.lens}: no catalogue row; dispatching the free-form lens unchanged`)
  return prompt
}
