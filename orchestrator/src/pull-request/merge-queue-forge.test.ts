import { expect, test } from 'bun:test'
import { failedMergeGroupRunFromPages } from './merge-queue-forge.ts'

test('the failed merge-group run walk stops on the first page with a match', () => {
  const pages: number[] = []
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: index,
    event: 'merge_group',
    head_branch: 'gh-readonly-queue/main/pr-41-other',
    conclusion: 'failure',
    html_url: `https://github.example/actions/runs/${index}`,
  }))
  firstPage[37] = {
    id: 9876,
    event: 'merge_group',
    head_branch: 'gh-readonly-queue/main/pr-42-match',
    conclusion: 'failure',
    html_url: 'https://github.example/actions/runs/9876',
  }

  expect(
    failedMergeGroupRunFromPages(
      (page) => {
        pages.push(page)
        if (page !== 1) throw new Error(`unexpected page ${page}`)
        return firstPage
      },
      'main',
      42,
    ),
  ).toEqual({ id: 9876, url: 'https://github.example/actions/runs/9876' })
  expect(pages).toEqual([1])
})
