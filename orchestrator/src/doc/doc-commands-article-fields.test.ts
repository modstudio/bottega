import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { register } from '../commands/docs.ts'
import { drainStdout } from '../commands/support.ts'
import { upsertProject } from '../project/projects.ts'
import { addSubject } from '../subject/subjects.ts'

async function command(args: string[], stdin = '') {
  const fixture = stdin ? mkdtempSync(join(tmpdir(), 'doc-command-body-')) : null
  const bodyFile = fixture ? join(fixture, 'body.md') : null
  if (bodyFile) writeFileSync(bodyFile, stdin)
  const program = new Command().enablePositionalOptions().exitOverride()
  register(program)
  const out: string[] = []
  const err: string[] = []
  const originalWrite = process.stdout.write
  const originalError = console.error
  const originalExitCode = process.exitCode
  process.exitCode = 0
  process.stdout.write = ((value: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    out.push(String(value))
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    if (typeof done === 'function') done()
    return true
  }) as typeof process.stdout.write
  console.error = (...values: unknown[]) => err.push(values.join(' '))
  let code = 0
  try {
    await program.parseAsync(['node', 'orch', ...args, ...(bodyFile ? ['--file', bodyFile] : [])])
  } catch (error) {
    code = 1
    err.push((error as Error).message)
  } finally {
    await drainStdout()
    process.stdout.write = originalWrite
    console.error = originalError
    code = Number(process.exitCode || code)
    process.exitCode = originalExitCode
    if (fixture) rmSync(fixture, { recursive: true, force: true })
  }
  return { code, out: out.join('').trimEnd(), err: err.join('\n') }
}

const setArgs = (slug: string, ...options: string[]) => [
  'doc',
  'set',
  slug,
  '--scope',
  'project',
  '--subject',
  'article-command-project',
  '--title',
  slug,
  '--reason',
  'command regression',
  '--delivery',
  'demand',
  ...options,
]

const show = async (slug: string) => {
  const result = await command([
    'doc',
    'show',
    slug,
    '--scope',
    'project',
    '--subject',
    'article-command-project',
    '--json',
  ])
  expect(result.code).toBe(0)
  return JSON.parse(result.out)
}

test(`${PLATFORM_SLUG} doc commands preserve, clear, and list article fields by subject name`, async () => {
  upsertProject({
    recordId: newRecordId(),
    name: 'article-command-project',
    path: '/w/article-command-project',
    settings: {},
  })
  const pricing = await addSubject({
    project: 'article-command-project',
    name: 'Pricing',
    definition: 'Pricing.',
  })
  const product = await addSubject({
    project: 'article-command-project',
    name: 'Product',
    definition: 'Product.',
  })
  const strategy = await addSubject({
    project: 'article-command-project',
    name: 'Strategy',
    definition: 'Strategy.',
  })

  expect(
    await command(setArgs('working-summary', '--summary', '  Summary for every doc.  '), 'Body.'),
  ).toMatchObject({ code: 0 })
  expect(await show('working-summary')).toMatchObject({
    kind: 'working',
    summary: 'Summary for every doc.',
    summarySource: 'written',
  })

  const created = await command(
    setArgs(
      'pricing-own',
      '--kind',
      'article',
      '--audience',
      'technical',
      '--form',
      'feature',
      '--article-subject',
      'Pricing',
      '--related-subject',
      'Product',
      '--related-subject',
      'Strategy',
      '--source-file',
      'docs/pricing.md',
      '--source-file',
      'src/pricing.ts',
      '--summary',
      'Written pricing summary',
      '--checked-at',
      '1111111111111111111111111111111111111111',
    ),
    'Pricing body.',
  )
  expect(created).toMatchObject({ code: 0 })
  expect(await show('pricing-own')).toMatchObject({
    form: 'feature',
    articleSubject: { id: pricing.id, name: 'Pricing' },
    relatedSubjects: [
      { id: product.id, name: 'Product' },
      { id: strategy.id, name: 'Strategy' },
    ],
    sourceFiles: ['docs/pricing.md', 'src/pricing.ts'],
    summary: 'Written pricing summary',
    summarySource: 'written',
    checkedAgainstCommit: '1111111111111111111111111111111111111111',
  })

  expect(await command(setArgs('pricing-own'), 'Updated pricing body.')).toMatchObject({ code: 0 })
  expect(await show('pricing-own')).toMatchObject({
    form: 'feature',
    articleSubject: { id: pricing.id },
    relatedSubjects: [{ id: product.id }, { id: strategy.id }],
    sourceFiles: ['docs/pricing.md', 'src/pricing.ts'],
    summary: 'Written pricing summary',
    summarySource: 'written',
    checkedAgainstCommit: '1111111111111111111111111111111111111111',
  })

  expect(
    await command(
      setArgs(
        'pricing-related',
        '--kind',
        'article',
        '--audience',
        'technical',
        '--article-subject',
        'Product',
        '--related-subject',
        'Pricing',
      ),
      'Related pricing body.',
    ),
  ).toMatchObject({ code: 0 })

  for (const extra of [[], ['--match', 'pricing']]) {
    const listed = await command([
      'doc',
      'list',
      '--scope',
      'project',
      '--subject',
      'article-command-project',
      '--article-subject',
      'Pricing',
      ...extra,
      '--json',
    ])
    expect(listed.code).toBe(0)
    expect(JSON.parse(listed.out).map((doc: { slug: string }) => doc.slug)).toEqual([
      'pricing-own',
      'pricing-related',
    ])
  }

  const unknown = await command([
    'doc',
    'list',
    '--scope',
    'project',
    '--subject',
    'article-command-project',
    '--article-subject',
    'Unknown',
  ])
  expect(unknown.code).toBe(1)
  expect(unknown.err).toContain(`${PLATFORM_SLUG} doc subject list article-command-project`)

  for (const address of [[], ['--scope', 'project']]) {
    const unscoped = await command(['doc', 'list', ...address, '--article-subject', 'Pricing'])
    expect(unscoped).toMatchObject({
      code: 1,
      err: expect.stringContaining('article subject filter requires project scope and subject'),
    })
  }

  const clearCases = [
    [
      '--no-form',
      {
        form: null,
        articleSubject: { id: pricing.id },
        relatedSubjects: [{ id: product.id }, { id: strategy.id }],
        sourceFiles: ['docs/pricing.md', 'src/pricing.ts'],
        checkedAgainstCommit: '1111111111111111111111111111111111111111',
      },
    ],
    [
      '--no-article-subject',
      {
        form: null,
        articleSubject: null,
        relatedSubjects: [{ id: product.id }, { id: strategy.id }],
        sourceFiles: ['docs/pricing.md', 'src/pricing.ts'],
        checkedAgainstCommit: '1111111111111111111111111111111111111111',
      },
    ],
    [
      '--no-related-subjects',
      {
        form: null,
        articleSubject: null,
        relatedSubjects: [],
        sourceFiles: ['docs/pricing.md', 'src/pricing.ts'],
        checkedAgainstCommit: '1111111111111111111111111111111111111111',
      },
    ],
    [
      '--no-source-files',
      {
        form: null,
        articleSubject: null,
        relatedSubjects: [],
        sourceFiles: [],
        checkedAgainstCommit: '1111111111111111111111111111111111111111',
      },
    ],
    [
      '--no-summary',
      {
        form: null,
        articleSubject: null,
        relatedSubjects: [],
        sourceFiles: [],
        summary: 'Cleared one field.',
        summarySource: 'derived',
        checkedAgainstCommit: '1111111111111111111111111111111111111111',
      },
    ],
    [
      '--no-checked-at',
      {
        form: null,
        articleSubject: null,
        relatedSubjects: [],
        sourceFiles: [],
        checkedAgainstCommit: null,
      },
    ],
  ] as const
  for (const [flag, expected] of clearCases) {
    expect(await command(setArgs('pricing-own', flag), 'Cleared one field.')).toMatchObject({
      code: 0,
    })
    expect(await show('pricing-own')).toMatchObject(expected)
  }
})
