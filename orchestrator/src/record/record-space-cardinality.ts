// concern: record-space-cardinality
/** Decides whether one record id has at most one hosted-record home. */

export type SingleRecordSpaceDecision = { index: number } | { index: null } | { refused: string }

export function decideSingleRecordSpace(
  answers: Array<{ spaceId: string; found: boolean }>,
): SingleRecordSpaceDecision {
  const found = answers.flatMap((answer, index) => (answer.found ? [{ ...answer, index }] : []))
  if (found.length > 1)
    return {
      refused: `hosted task-flow record exists in more than one record space: ${found
        .map(({ spaceId }) => spaceId)
        .join(', ')}`,
    }
  return { index: found[0]?.index ?? null }
}
