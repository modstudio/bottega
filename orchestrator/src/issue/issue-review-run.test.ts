import { describe, expect, test } from 'bun:test'
import { dispatchThenGatherIssueReviews, runIssueFixReviews } from './issue-review-run.ts'

const gathered = (lens: string, runId: number | null) => ({
  lens,
  finished: runId !== null,
  failedToRun: runId === null ? 'blocked' : null,
  findingCount: runId === null ? null : 0,
  findings: runId === null ? null : [],
  runId,
})

describe('filed issue review adapter', () => {
  test('waits for each lens claim before dispatching the next and gathers in lens order', async () => {
    let firstClaimed = false
    const dispatched: string[] = []
    const gathered: string[] = []

    const results = await dispatchThenGatherIssueReviews(
      ['issue-blast-radius', 'correctness'],
      undefined,
      {
        dispatch: async (lens) => {
          dispatched.push(lens)
          if (lens === 'issue-blast-radius') {
            await Promise.resolve()
            firstClaimed = true
            return { claim: { runId: 11, failedToRun: null }, dispatchNext: true }
          }
          expect(firstClaimed).toBe(true)
          return { claim: { runId: 12, failedToRun: null }, dispatchNext: true }
        },
        blocked: () => ({ runId: null, failedToRun: 'blocked' }),
        gather: async (lens, claim) => {
          if (lens === 'issue-blast-radius') await Promise.resolve()
          gathered.push(lens)
          return {
            lens,
            finished: true,
            failedToRun: null,
            findingCount: 0,
            findings: [],
            runId: claim.runId,
          }
        },
        modelForRun: () => 'unused',
      },
    )

    expect(dispatched).toEqual(['issue-blast-radius', 'correctness'])
    expect(gathered).toEqual(['correctness', 'issue-blast-radius'])
    expect(results.map(({ lens, runId }) => `${lens}:${runId}`)).toEqual([
      'issue-blast-radius:11',
      'correctness:12',
    ])
  })

  test('gathers a started lens and does not dispatch another while it remains pending', async () => {
    const dispatched: string[] = []
    const gathered: string[] = []

    const results = await dispatchThenGatherIssueReviews(
      ['issue-blast-radius', 'correctness'],
      undefined,
      {
        dispatch: async (lens) => {
          dispatched.push(lens)
          return { claim: { runId: 11, failedToRun: null }, dispatchNext: false }
        },
        blocked: (_lens, blockingLens) => ({
          runId: null,
          failedToRun: `blocked-by:${blockingLens}`,
        }),
        gather: async (lens, claim) => {
          gathered.push(lens)
          return gatheredResult(lens, claim.runId, claim.failedToRun)
        },
        modelForRun: () => 'unused',
      },
    )

    expect(dispatched).toEqual(['issue-blast-radius'])
    expect(gathered).toEqual(['issue-blast-radius', 'correctness'])
    expect(results.map(({ lens, runId, failedToRun }) => ({ lens, runId, failedToRun }))).toEqual([
      { lens: 'issue-blast-radius', runId: 11, failedToRun: null },
      { lens: 'correctness', runId: null, failedToRun: 'blocked-by:issue-blast-radius' },
    ])
  })

  test('gathers the first declared opinion before dispatching its different-model repeat', async () => {
    const events: string[] = []
    let nextRunId = 10

    const results = await dispatchThenGatherIssueReviews(
      ['issue-blast-radius', 'correctness', 'craft'],
      'correctness',
      {
        dispatch: async (lens, distinctModels) => {
          events.push(`dispatch:${lens}:${distinctModels.join(',')}`)
          return {
            claim: { runId: ++nextRunId, failedToRun: null },
            dispatchNext: true,
          }
        },
        blocked: () => ({ runId: null, failedToRun: 'blocked' }),
        gather: async (lens, claim) => {
          events.push(`gather-start:${lens}:${claim.runId}`)
          await Promise.resolve()
          events.push(`gather-end:${lens}:${claim.runId}`)
          return gathered(lens, claim.runId)
        },
        modelForRun: (runId) => `effective-model-${runId}`,
      },
    )

    expect(events.filter((event) => event.startsWith('dispatch:'))).toEqual([
      'dispatch:issue-blast-radius:',
      'dispatch:correctness:',
      'dispatch:craft:',
      'dispatch:correctness:effective-model-12',
    ])
    expect(events.indexOf('gather-end:correctness:12')).toBeLessThan(
      events.indexOf('dispatch:correctness:effective-model-12'),
    )
    expect(results.map(({ lens, runId }) => `${lens}:${runId}`)).toEqual([
      'issue-blast-radius:11',
      'correctness:12',
      'correctness:14',
      'craft:13',
    ])
  })

  test('returns review-not-started when the fix has no worktree', async () => {
    const result = await runIssueFixReviews({
      issue: { key: 'DEV-42' } as never,
      fixRun: { id: 42, worktree: null } as never,
      target: { name: 'sample' } as never,
      branchKey: 'DEV-42',
    })

    expect(result).toEqual({
      tier: null,
      selectedLenses: [],
      reviewNotStarted: 'fix run 42 has no worktree to review',
      results: [],
    })
  })
})

function gatheredResult(lens: string, runId: number | null, failure: string | null) {
  return {
    ...gathered(lens, runId),
    failedToRun: failure,
  }
}
