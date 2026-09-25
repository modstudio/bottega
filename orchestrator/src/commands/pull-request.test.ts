import { expect, test } from 'bun:test'
import { validateGithubArguments } from './pull-request.ts'

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
