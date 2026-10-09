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
          return 11
        }
        expect(firstClaimed).toBe(true)
        return 12
      },
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
})
