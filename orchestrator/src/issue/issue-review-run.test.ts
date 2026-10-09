import { describe, expect, test } from 'bun:test'
import { dispatchThenGatherIssueReviews } from './issue-review-run.ts'

describe('filed issue review adapter', () => {
  test('waits for each lens claim before dispatching the next and gathers in lens order', async () => {
    let firstClaimed = false
    const dispatched: string[] = []
    const gathered: string[] = []

    const results = await dispatchThenGatherIssueReviews(
      ['issue-blast-radius', 'correctness'],
      async (lens) => {
        dispatched.push(lens)
        if (lens === 'issue-blast-radius') {
          await Promise.resolve()
          firstClaimed = true
          return { claim: 11, dispatchNext: true }
        }
        expect(firstClaimed).toBe(true)
        return { claim: 12, dispatchNext: true }
      },
      () => -1,
      async (lens, runId) => {
        if (lens === 'issue-blast-radius') await Promise.resolve()
        gathered.push(lens)
        return `${lens}:${runId}`
      },
    )

    expect(dispatched).toEqual(['issue-blast-radius', 'correctness'])
    expect(gathered).toEqual(['correctness', 'issue-blast-radius'])
    expect(results).toEqual(['issue-blast-radius:11', 'correctness:12'])
  })

  test('gathers a started lens and does not dispatch another while it remains pending', async () => {
    const dispatched: string[] = []
    const gathered: string[] = []

    const results = await dispatchThenGatherIssueReviews<number | string, string>(
      ['issue-blast-radius', 'correctness'],
      async (lens) => {
        dispatched.push(lens)
        return { claim: 11, dispatchNext: false }
      },
      (lens, blockingLens) => `${lens}:blocked-by:${blockingLens}`,
      async (lens, claim) => {
        gathered.push(lens)
        return `${lens}:${claim}`
      },
    )

    expect(dispatched).toEqual(['issue-blast-radius'])
    expect(gathered).toEqual(['issue-blast-radius', 'correctness'])
    expect(results).toEqual([
      'issue-blast-radius:11',
      'correctness:correctness:blocked-by:issue-blast-radius',
    ])
  })
})
