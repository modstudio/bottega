import { beforeAll, describe, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { projectOf, projectOfKey } from './attribute.ts'
import { projectColor, projectNames } from './projects.ts'

beforeAll(resetFixtureStore)

describe('project attribution', () => {
  test('the process uses the fixture register and its theme colors', () => {
    expect(projectNames()).toContain('alpha')
    expect(projectColor('alpha')).toBe('#112233')
    expect(projectColor('alpha', true)).toBe('#aabbcc')
    expect(projectColor('beta')).toBeNull()
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

  test('each prefix routes to its project', () => {
    expect(projectOfKey('ALP-5347')).toBe('alpha')
    expect(projectOfKey('BET-2533')).toBe('beta')
    expect(projectOfKey('GAM-986')).toBe('gamma')
    expect(projectOfKey('DEL-708')).toBe('delta')
    expect(projectOfKey('SHUL-12')).toBe('delta')
    expect(projectOfKey('LOC-1')).toBe('workshop')
    expect(projectOfKey('NOPE-1')).toBeNull()
  })
})
