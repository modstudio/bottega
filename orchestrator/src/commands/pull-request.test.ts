import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { pullRequestCiCommandOutcome, register, validateGithubArguments } from './pull-request.ts'

test('PR create consumes --cwd instead of forwarding it to GitHub', () => {
  const program = new Command()
  register(program)
  const pr = program.commands.find((command) => command.name() === 'pr')!
  const create = pr.commands.find((command) => command.name() === 'create')!

  const parsed = create.parseOptions(['--cwd', '/tmp/DEV-1849-tree', '--title', 'DEV-1849 title'])

  expect(create.opts().cwd).toBe('/tmp/DEV-1849-tree')
  expect(parsed.unknown).toEqual(['--title', 'DEV-1849 title'])
})

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
