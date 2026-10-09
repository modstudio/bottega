import { describe, expect, test } from 'bun:test'
import {
  applyTestWaivers,
  introducedTestFindings,
  type TestFinding,
  type TestWaiver,
} from './test-substance'

function finding(testName: string, line = 4): TestFinding {
  return {
    file: 'example.test.ts',
    line,
    rule: 'assertions-in-tests',
    testName,
    message: 'Add at least one assertion to this test case.',
  }
}

describe('test substance comparison', () => {
  test('returns a new finding', () => {
    expect(introducedTestFindings([], [finding('suite > new test')])).toEqual([
      finding('suite > new test'),
    ])
  })

  test('does not return an existing finding which moved lines', () => {
    expect(introducedTestFindings([finding('same', 4)], [finding('same', 40)])).toEqual([])
  })

  test('returns an existing finding whose test was renamed', () => {
    expect(introducedTestFindings([finding('old')], [finding('new')])).toEqual([finding('new')])
  })

  test('returns a second instance of an existing finding in one test', () => {
    expect(
      introducedTestFindings([finding('same')], [finding('same'), finding('same', 8)]),
    ).toEqual([finding('same')])
  })

  test('returns the new instance when it precedes the old instance', () => {
    expect(
      introducedTestFindings([finding('same', 8)], [finding('same', 4), finding('same', 8)]),
    ).toEqual([finding('same', 4)])
  })

  test('returns an addition in another test when a finding was removed', () => {
    expect(introducedTestFindings([finding('removed')], [finding('added')])).toEqual([
      finding('added'),
    ])
  })
})

describe('test substance waivers', () => {
  function waiver(reason: string, testName = 'same'): TestWaiver {
    return {
      file: 'example.test.ts',
      line: 3,
      testName,
      rule: 'assertions-in-tests',
      reason,
    }
  }

  test('suppresses a matching rule with a reason', () => {
    expect(applyTestWaivers([finding('same')], [waiver('covered by integration')])).toEqual([])
  })

  test('does not suppress when the reason is missing or one word', () => {
    expect(applyTestWaivers([finding('same')], [waiver('insufficient')])).toEqual([finding('same')])
  })

  test('reports an unused waiver', () => {
    expect(applyTestWaivers([], [waiver('covered by integration')])).toEqual([
      {
        file: 'example.test.ts',
        line: 3,
        rule: 'unused-waiver',
        testName: 'same',
        message: 'waiver for assertions-in-tests suppresses no finding',
      },
    ])
  })
})
