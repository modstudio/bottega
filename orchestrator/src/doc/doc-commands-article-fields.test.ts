import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { collectCanonLintInput } from '../canon/canon-files.ts'
import { register } from '../commands/docs.ts'
import { optionFlags } from '../commands/support.ts'
import { upsertProject } from '../project/projects.ts'
import { addSubject } from '../subject/subjects.ts'
import { docCommand } from './doc-commands.ts'
import { selectDocWriteTree } from './doc-write-tree.ts'

async function command(args: string[], stdin = '') {
  const program = new Command().exitOverride()
  register(program)
  const registered = program.commands.find((candidate) => candidate.name() === 'doc')!
  const parsed = registered.parseOptions(args.slice(1))
  const flags = optionFlags(registered.opts())
  const out: string[] = []
  const err: string[] = []
  let code = 0
  try {
    await docCommand(
      parsed.operands[0] ?? 'list',
      ['doc', ...parsed.operands],
      flags,
      {
        log: (...parts: unknown[]) => out.push(parts.join(' ')),
        error: (...parts: unknown[]) => err.push(parts.join(' ')),
        write: (value: string) => out.push(value),
        stdinText: async () => stdin,
        stdinIsTTY: false,
        cwd: () => process.cwd(),
        exitCode: (value: number) => {
          code = value
        },
      },
      { selectDocWriteTree, collectCanonLintInput },
    )
  } catch (error) {
    code = 1
    err.push((error as Error).message)
  }
  return { code, out: out.join('\n'), err: err.join('\n') }
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
    checkedAgainstCommit: '1111111111111111111111111111111111111111',
  })

  expect(await command(setArgs('pricing-own'), 'Updated pricing body.')).toMatchObject({ code: 0 })
  expect(await show('pricing-own')).toMatchObject({
    form: 'feature',
    articleSubject: { id: pricing.id },
    relatedSubjects: [{ id: product.id }, { id: strategy.id }],
    sourceFiles: ['docs/pricing.md', 'src/pricing.ts'],
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
