import { describe, expect, test } from 'bun:test'
import {
  applyTestWaivers,
  introducedTestFindings,
  isTestFile,
  judgeTestSubstance,
  type TestFinding,
  type TestWaiver,
} from './test-substance'

test('judges an absolute test path outside the current checkout', async () => {
  expect(
    await judgeTestSubstance({
      file: '/another/project/example.test.ts',
      before: null,
      after: 'import { test } from "bun:test"\ntest("empty", () => {})\n',
    }),
  ).toMatchObject({
    status: 'refused',
    findings: [{ test: 'empty', rule: 'no-assertion' }],
  })
})

test('reports an unparseable test as unchecked', async () => {
  expect(
    await judgeTestSubstance(
      { file: 'example.test.ts', before: null, after: 'broken' },
      async () => ({
        testSubstanceReport: async () => ({
          findings: [],
          parseError: 'could not parse test',
          runner: 'bun',
        }),
      }),
    ),
  ).toEqual({ status: 'unchecked', findings: [], reason: 'could not parse test' })
})

test('reports unavailable detectors as unchecked', async () => {
  expect(
    await judgeTestSubstance(
      { file: 'example.test.ts', before: null, after: 'content' },
      async () => {
        throw new Error("Cannot find module 'eslint'")
      },
    ),
  ).toEqual({
    status: 'unchecked',
    findings: [],
    reason: "detectors unavailable in this build: Cannot find module 'eslint'",
  })
})

test('reports detector failures for proposed and prior content as unchecked', async () => {
  const failingAfter = async () => ({
    testSubstanceReport: async () => {
      throw new Error('lint exploded')
    },
  })
  expect(
    await judgeTestSubstance(
      { file: 'example.test.ts', before: null, after: 'content' },
      failingAfter,
    ),
  ).toEqual({ status: 'unchecked', findings: [], reason: 'detector failed: lint exploded' })

  let calls = 0
  expect(
    await judgeTestSubstance(
      { file: 'example.test.ts', before: 'before', after: 'after' },
      async () => ({
        testSubstanceReport: async () => {
          calls += 1
          if (calls === 2) throw new Error('prior lint exploded')
          return { findings: [], runner: 'bun' }
        },
      }),
    ),
  ).toEqual({ status: 'unchecked', findings: [], reason: 'detector failed: prior lint exploded' })
})

test('matches only the supported JavaScript and TypeScript test extensions', () => {
  for (const extension of ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts']) {
    expect(isTestFile(`/project/example.test.${extension}`)).toBe(true)
    expect(isTestFile(`/project/example.spec.${extension}`)).toBe(true)
  }
  for (const extension of ['mtsx', 'ctsx', 'mjsx', 'cjsx']) {
    expect(isTestFile(`/project/example.test.${extension}`)).toBe(false)
  }
})

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
