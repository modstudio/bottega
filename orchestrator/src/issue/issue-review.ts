// concern: filed-issue review policy
/** Pure lens selection and readiness. Must not know runs, routing, projects, or stores. */

export const ISSUE_BLAST_RADIUS_LENS = 'issue-blast-radius'

export type IssueReviewLensResult = {
  lens: string
  finished: boolean
  failedToRun: string | null
  findingCount: number | null
  findings: unknown[] | null
  runId: number | null
}

export type IssueReviewDecision = {
  ready: boolean
  lensesWithFindings: string[]
  lensesNotRun: string[]
}

/** Add the coordinator-specific lens without duplicating a declared lens. */
export function issueReviewLenses(tierLenses: readonly string[]): string[] {
  return [ISSUE_BLAST_RADIUS_LENS, ...tierLenses.filter((lens) => lens !== ISSUE_BLAST_RADIUS_LENS)]
}

/** Decide readiness only from the result of every lens the coordinator dispatched. */
export function issueReviewDecision(
  results: readonly Pick<
    IssueReviewLensResult,
    'lens' | 'finished' | 'failedToRun' | 'findingCount'
  >[],
): IssueReviewDecision {
  const lensesNotRun = results
    .filter(
      (result) => !result.finished || result.failedToRun !== null || result.findingCount === null,
    )
    .map((result) => result.lens)
  const lensesWithFindings = results
    .filter((result) => result.finished && (result.findingCount ?? 0) > 0)
    .map((result) => result.lens)
  return {
    ready: lensesNotRun.length === 0 && lensesWithFindings.length === 0,
    lensesWithFindings,
    lensesNotRun,
  }
}

/** One durable task-document line for a gathered lens result. */
export function issueReviewEvidence(result: IssueReviewLensResult): string {
  const run = result.runId ?? 'not started'
  if (!result.finished || result.failedToRun !== null) {
    return `${result.lens} lens run: ${run}; did not run: ${result.failedToRun ?? 'did not finish'}`
  }
  return `${result.lens} lens run: ${run}; findings: ${JSON.stringify(result.findings ?? [])}`
}
