import { describe, expect, test } from 'bun:test'
import { runCollectionDescribeFixture } from '../fixtures/cli.ts'


/** Process-boundary rows retained until the boundary suite is consolidated. */
describe('detached run collection', () => {
  const { orch, insert } = runCollectionDescribeFixture()

  test('result on a still-running run exits 2, not 1', () => {
    const id = insert('running')
    const result = orch('result', String(id))
    expect(result.code).toBe(2)
    expect(result.err).toContain('still running')
  })

  test('result on an unknown run says so rather than exiting 2', () => {
    expect(orch('result', '999999').code).toBe(1)
  })
})
