import { beforeAll, describe, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { projectOf } from './attribute.ts'
import { projectNames } from './projects.ts'

beforeAll(resetFixtureStore)

describe('project attribution', () => {
  test('the process uses the fixture register', () => {
    expect(projectNames()).toContain('alpha')
  })

  test('a checkout names its project', () => {
    expect(projectOf('/fixtures/repos/alpha')).toBe('alpha')
    expect(projectOf('/fixtures/repos/workshop/orchestrator')).toBe('workshop')
    expect(projectOf('/fixtures/repos/alpha/packages/nested/src')).toBe('nested')
  })

  test('a numbered clone is the same project', () => {
    // The other machine checks out alpha-0, beta-1 and so on. Missing
    // this once read 65% of a window's canon work as untracked.
    expect(projectOf('/fixtures/repos/alpha-0')).toBe('alpha')
    expect(projectOf('/fixtures/repos/beta-2')).toBe('beta')
  })

  test('anything outside ~/Projects belongs to no project', () => {
    expect(projectOf('/tmp/scratch')).toBeNull()
    expect(projectOf(undefined)).toBeNull()
    expect(projectOf('/fixtures/repos/some-other-repo')).toBeNull()
  })
})
