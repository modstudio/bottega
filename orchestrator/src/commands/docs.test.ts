import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { assertUserCanonHydrateAllowed, register } from './docs.ts'
import { optionFlags } from './support.ts'

const flags = (...names: string[]) => ({ has: (name: string) => names.includes(name) })

function parseDocOptions(argv: string[]) {
  const program = new Command().exitOverride()
  register(program)
  const command = program.commands.find((candidate) => candidate.name() === 'doc')!
  const parsed = command.parseOptions(argv)
  return { parsed, options: command.opts() }
}

test('the registered doc command parses status, set, and filtered list lifecycle flags', () => {
  expect(
    parseDocOptions([
      'status',
      'guide',
      '--scope',
      'global',
      '--status',
      'superseded',
      '--replacement',
      'new-guide',
    ]),
  ).toMatchObject({
    parsed: { operands: ['status', 'guide'], unknown: [] },
    options: { scope: 'global', status: 'superseded', replacement: 'new-guide' },
  })
  expect(parseDocOptions(['set', 'guide', '--scope', 'global', '--status', 'draft'])).toMatchObject(
    {
      parsed: { operands: ['set', 'guide'], unknown: [] },
      options: { scope: 'global', status: 'draft' },
    },
  )
  expect(parseDocOptions(['list', '--status', 'archived'])).toMatchObject({
    parsed: { operands: ['list'], unknown: [] },
    options: { status: 'archived' },
  })
  expect(parseDocOptions(['set', 'guide', '--kind', 'article'])).toMatchObject({
    parsed: { operands: ['set', 'guide'], unknown: [] },
    options: { kind: 'article' },
  })
  expect(parseDocOptions(['list', '--kind', 'working'])).toMatchObject({
    parsed: { operands: ['list'], unknown: [] },
    options: { kind: 'working' },
  })
})

test('the registered doc clear options are presence flags', () => {
  const clearFlags = [
    'no-parent',
    'no-form',
    'no-article-subject',
    'no-related-subjects',
    'no-source-files',
    'no-checked-at',
  ]

  const absent = optionFlags(parseDocOptions(['set', 'guide']).options)
  for (const flag of clearFlags) expect(absent.has(flag)).toBeFalse()

  for (const flag of clearFlags) {
    const given = optionFlags(parseDocOptions(['set', 'guide', `--${flag}`]).options)
    expect(given.has(flag)).toBeTrue()
  }

  const relatedSubject = optionFlags(
    parseDocOptions(['set', 'guide', '--related-subject', 'subject']).options,
  )
  expect(relatedSubject.has('no-related-subjects')).toBeFalse()

  const sourceFile = optionFlags(
    parseDocOptions(['set', 'guide', '--source-file', 'docs/guide.md']).options,
  )
  expect(sourceFile.has('no-source-files')).toBeFalse()

  const checkedAt = optionFlags(
    parseDocOptions(['set', 'guide', '--checked-at', '1'.repeat(40)]).options,
  )
  expect(checkedAt.has('no-checked-at')).toBeFalse()
})

test('an orch worker cannot hydrate user canon but can check it', () => {
  const inventory = {
    ascertainable: true as const,
    rows: [
      { pid: 100, ppid: 1, pgid: 100, command: 'bun orchestrator/src/run/exec.ts 6731 prompt job' },
      { pid: 200, ppid: 100, pgid: 100, command: 'codex worker' },
      { pid: 300, ppid: 200, pgid: 100, command: `${PLATFORM_SLUG} doc canon hydrate --user` },
    ],
  }

  expect(() => assertUserCanonHydrateAllowed(flags(), {}, 300, inventory)).toThrow(
    `refusing user canon hydrate from an orch worker run; an operator must run ${PLATFORM_SLUG} doc canon hydrate --user`,
  )
  expect(() => assertUserCanonHydrateAllowed(flags('check'), {}, 300, inventory)).not.toThrow()
})
