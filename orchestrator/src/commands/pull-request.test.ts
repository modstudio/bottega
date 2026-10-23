import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { pullRequestCiCommandOutcome, validateGithubArguments } from './pull-request.ts'

test('PR admission accepts GitHub content arguments', () => {
  expect(() =>
    validateGithubArguments(['--title', 'DEV-977 title', '--body-file', '/tmp/body']),
  ).not.toThrow()
})

test('PR admission refuses caller-controlled target and output modes in every form', () => {
  for (const args of [
    ['--head', 'other'],
    ['--head=other'],
    ['-Hother'],
    ['--base', 'other'],
    ['--base=other'],
    ['-Bother'],
    ['--repo=x/y'],
    ['-Rx/y'],
    ['--web'],
    ['-w'],
    ['--dry-run'],
    ['--recover=value'],
    ['--json=number,url'],
  ]) {
    expect(() => validateGithubArguments(args)).toThrow('refuses')
  }
})

test('an incomplete CI record reports only its error and exits unsuccessfully', () => {
  expect(
    pullRequestCiCommandOutcome({
      prNumber: 42,
      complete: false,
      counts: { ciRuns: 0, reruns: 0, flakeAttributedReruns: 0 },
      error: `CI recording incomplete for PR #42: unavailable; retry: ${PLATFORM_SLUG} pr ci-record 42`,
    }),
  ).toEqual({
    output: null,
    error: `CI recording incomplete for PR #42: unavailable; retry: ${PLATFORM_SLUG} pr ci-record 42`,
    exitCode: 1,
  })
})
