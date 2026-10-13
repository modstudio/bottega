// concern: review-lens-prompt
/**
 * Knows how a findings-lens dispatch prompt is composed from a lens definition
 * and any supplied extra context. Must not know the store, CLI, or jobs.
 */

type ReviewLensDefinition = {
  question: string
  excludes: string
}

type MechanicallyEnforcedCheck = {
  title: string
  tool: string
}

const ENFORCED_BY_TOOL_EXPLANATION =
  'A blocking tool refuses these before a change can land here. Do not report a finding whose whole substance is one of them. A defect in the same area that the tool cannot judge is still yours to report.'

function lensText(lens: ReviewLensDefinition): string {
  return `QUESTION\n${lens.question}\n\nEXCLUDES\n${lens.excludes}`
}

/** Compose a findings-lens prompt: lens definition first, supplied text after. */
export function reviewLensPrompt(input: {
  lens: ReviewLensDefinition | null
  mechanicallyEnforced: readonly MechanicallyEnforcedCheck[]
  supplied: string
}): string {
  if (!input.lens) {
    if (!input.supplied.trim()) throw new Error('empty prompt')
    return input.supplied
  }
  const extra = input.supplied.trim()
  const enforced = input.mechanicallyEnforced.length
    ? `\n\nENFORCED BY TOOL IN THIS PROJECT\n${input.mechanicallyEnforced
        .map((check) => `${check.title}: ${check.tool}`)
        .join('\n')}\n\n${ENFORCED_BY_TOOL_EXPLANATION}`
    : ''
  const definition = `${lensText(input.lens)}${enforced}`
  return extra ? `${definition}\n\n${extra}` : definition
}
