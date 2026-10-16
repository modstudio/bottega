// concern: review-lens-prompt
/**
 * Knows how a findings-lens dispatch prompt is composed from a lens definition
 * and any supplied extra context. Must not know the store, CLI, or jobs.
 */

import type { ReviewFindingMemory } from './review-memory.ts'

type ReviewLensDefinition = {
  question: string
  excludes: string
}

type MechanicallyEnforcedCheck = {
  title: string
  tool: string
}

export const MAX_EARLIER_ROUND_REJECTIONS = 20

const EARLIER_ROUND_INSTRUCTION =
  'Do not raise a finding these entries already rejected unless the code at that location changed since the commit shown, or you have evidence the earlier ruling did not have. When you do raise one, say which entry it reopens and why.'

const ENFORCED_BY_TOOL_EXPLANATION =
  'A blocking tool refuses these before a change can land here. Do not report a finding whose whole substance is one of them. A defect in the same area that the tool cannot judge is still yours to report.'

function lensText(lens: ReviewLensDefinition): string {
  return `QUESTION\n${lens.question}\n\nEXCLUDES\n${lens.excludes}`
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Select and render rejection memory using only supplied review rows. */
export function renderEarlierRoundRejections(input: ReviewFindingMemory): string {
  if (!input.branch) return ''
  const selected = input.rows
    .filter(
      (row) =>
        row.project === input.project &&
        row.branch === input.branch &&
        row.completedAt !== null &&
        row.disposition === 'rejected',
    )
    .sort(
      (left, right) =>
        right.completedAt!.localeCompare(left.completedAt!) ||
        right.reviewId - left.reviewId ||
        left.ordinal - right.ordinal,
    )
  if (!selected.length) return ''
  const carried = selected.slice(0, MAX_EARLIER_ROUND_REJECTIONS)
  const dropped = selected.length - carried.length
  const entries = carried.map((row, index) => {
    const reason = row.triageReason ? `; reason: ${oneLine(row.triageReason)}` : ''
    return (
      `${index + 1}. ${row.location} — ${oneLine(row.evidence)} ` +
      `[rejected: ${row.rejectionCategory ?? 'unspecified'}${reason}; ` +
      `lens: ${row.lens}; reviewed commit: ${row.reviewedCommit ?? 'unknown'}]`
    )
  })
  const omitted = dropped
    ? `\n${dropped} earlier rejected finding(s) omitted by the carry cap.`
    : ''
  return `RULED IN EARLIER ROUNDS\n${entries.join('\n')}${omitted}\n\n${EARLIER_ROUND_INSTRUCTION}`
}

/** Compose a findings-lens prompt: lens definition first, supplied text after. */
export function reviewLensPrompt(input: {
  lens: ReviewLensDefinition | null
  mechanicallyEnforced: readonly MechanicallyEnforcedCheck[]
  earlierRejections: ReviewFindingMemory
  supplied: string
}): string {
  const extra = input.supplied.trim()
  const earlier = renderEarlierRoundRejections(input.earlierRejections)
  if (!input.lens) {
    if (!extra && !earlier) throw new Error('empty prompt')
    return [earlier, extra].filter(Boolean).join('\n\n')
  }
  const enforced = input.mechanicallyEnforced.length
    ? `\n\nENFORCED BY TOOL IN THIS PROJECT\n${input.mechanicallyEnforced
        .map((check) => `${check.title}: ${check.tool}`)
        .join('\n')}\n\n${ENFORCED_BY_TOOL_EXPLANATION}`
    : ''
  const memory = earlier ? `\n\n${earlier}` : ''
  const definition = `${lensText(input.lens)}${enforced}${memory}`
  return extra ? `${definition}\n\n${extra}` : definition
}
