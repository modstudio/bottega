// concern: review-lens-prompt
/**
 * Knows how a findings-lens dispatch prompt is composed from a lens definition
 * and any supplied extra context. Must not know the store, CLI, or jobs.
 */

type ReviewLensDefinition = {
  question: string
  excludes: string
}

function lensText(lens: ReviewLensDefinition): string {
  return `QUESTION\n${lens.question}\n\nEXCLUDES\n${lens.excludes}`
}

/** Compose a findings-lens prompt: lens definition first, supplied text after. */
export function reviewLensPrompt(input: {
  lens: ReviewLensDefinition | null
  supplied: string
}): string {
  if (!input.lens) {
    if (!input.supplied.trim()) throw new Error('empty prompt')
    return input.supplied
  }
  const extra = input.supplied.trim()
  const definition = lensText(input.lens)
  return extra ? `${definition}\n\n${extra}` : definition
}
