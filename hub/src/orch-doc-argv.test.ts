import { describe, expect, test } from 'bun:test'
import { docArgv } from './orch-doc-argv.ts'

test('owner-scoped doc wrappers never send an owner id', () => {
  expect(docArgv('list', { scope: 'canon', user: true })).toEqual([
    'doc',
    'list',
    '--scope',
    'canon',
    '--user',
    '--json',
  ])
  expect(
    docArgv('set', {
      scope: 'settings',
      user: true,
      slug: 'settings',
      title: 'settings',
      reason: 'change rule',
      expectedRevision: 'revision-1',
    }),
  ).toEqual([
    'doc',
    'set',
    'settings',
    '--scope',
    'settings',
    '--user',
    '--title',
    'settings',
    '--reason',
    'change rule',
    '--expect',
    'revision-1',
    '--json',
  ])
})

describe('docArgv', () => {
  test('list forwards keyword filters using the MCP option names', () => {
    expect(docArgv('list', { match: 'title', bodyMatch: 'body' })).toEqual([
      'doc',
      'list',
      '--match',
      'title',
      '--body-match',
      'body',
      '--json',
    ])
  })

  test('list with no filters', () => {
    expect(docArgv('list')).toEqual(['doc', 'list', '--json'])
  })

  test('list with scope', () => {
    expect(docArgv('list', { scope: 'global' })).toEqual([
      'doc',
      'list',
      '--scope',
      'global',
      '--json',
    ])
  })

  test('list with scope and subject', () => {
    expect(docArgv('list', { scope: 'project', subject: 'alpha' })).toEqual([
      'doc',
      'list',
      '--scope',
      'project',
      '--subject',
      'alpha',
      '--json',
    ])
  })

  test('get without subject', () => {
    expect(docArgv('get', { scope: 'global', subject: null, slug: 'hello' })).toEqual([
      'doc',
      'show',
      'hello',
      '--scope',
      'global',
      '--json',
    ])
  })

  test('get with subject', () => {
    expect(docArgv('get', { scope: 'project', subject: 'alpha', slug: 'hello' })).toEqual([
      'doc',
      'show',
      'hello',
      '--scope',
      'project',
      '--subject',
      'alpha',
      '--json',
    ])
  })

  test('set without subject does not put the body in argv', () => {
    const body = "quote' backtick` newline\n"
    const argv = docArgv('set', {
      scope: 'global',
      subject: null,
      slug: 'hello',
      title: 'Hi',
      body,
      reason: 'why',
    })
    expect(argv).toEqual([
      'doc',
      'set',
      'hello',
      '--scope',
      'global',
      '--title',
      'Hi',
      '--reason',
      'why',
      '--json',
    ])
    expect(argv).not.toContain(body)
  })

  test('set with subject', () => {
    expect(
      docArgv('set', {
        scope: 'agent',
        subject: 'codex',
        slug: 'notes',
        title: 'Notes',
        reason: 'why',
      }),
    ).toEqual([
      'doc',
      'set',
      'notes',
      '--scope',
      'agent',
      '--subject',
      'codex',
      '--title',
      'Notes',
      '--reason',
      'why',
      '--json',
    ])
  })

  test('set includes expect exactly when an expected revision is given', () => {
    const argv = docArgv('set', {
      scope: 'canon',
      subject: 'alpha',
      slug: '.agents/rules/docs.md',
      title: 'Docs',
      reason: 'updated',
      expectedRevision: 'revision-1',
    })
    const expectAt = argv.indexOf('--expect')
    expect(argv.filter((argument) => argument === '--expect')).toHaveLength(1)
    expect(argv.slice(expectAt, expectAt + 2)).toEqual(['--expect', 'revision-1'])
  })

  test('set maps article fields and their explicit clears to the CLI contract', () => {
    const cleared = docArgv('set', {
      scope: 'project',
      subject: 'alpha',
      slug: 'guide',
      title: 'Guide',
      reason: 'clear article fields',
      parentSlug: null,
      form: null,
      articleSubject: null,
      relatedSubjects: [],
      sourceFiles: [],
    })
    expect(cleared).toEqual([
      'doc',
      'set',
      'guide',
      '--scope',
      'project',
      '--subject',
      'alpha',
      '--title',
      'Guide',
      '--reason',
      'clear article fields',
      '--no-parent',
      '--no-form',
      '--no-article-subject',
      '--no-related-subjects',
      '--no-source-files',
      '--json',
    ])
  })

  test('set replaces a non-empty source-file list while related subjects remain additive flags', () => {
    const argv = docArgv('set', {
      scope: 'project',
      subject: 'alpha',
      slug: 'guide',
      title: 'Guide',
      reason: 'replace article fields',
      relatedSubjects: ['Product'],
      sourceFiles: ['docs/guide.md', 'src/guide.ts'],
    })
    expect(argv).toEqual([
      'doc',
      'set',
      'guide',
      '--scope',
      'project',
      '--subject',
      'alpha',
      '--title',
      'Guide',
      '--reason',
      'replace article fields',
      '--related-subject',
      'Product',
      '--no-source-files',
      '--source-file',
      'docs/guide.md',
      '--source-file',
      'src/guide.ts',
      '--json',
    ])
  })

  test('remove without subject', () => {
    expect(
      docArgv('remove', { scope: 'machine', subject: null, slug: 'host', reason: 'why' }),
    ).toEqual(['doc', 'rm', 'host', '--scope', 'machine', '--reason', 'why', '--json'])
  })

  test('remove with subject', () => {
    expect(
      docArgv('remove', { scope: 'job', subject: 'implement', slug: 'notes', reason: 'obsolete' }),
    ).toEqual([
      'doc',
      'rm',
      'notes',
      '--scope',
      'job',
      '--subject',
      'implement',
      '--reason',
      'obsolete',
      '--json',
    ])
  })

  test('remove includes expect exactly when an expected revision is given', () => {
    const argv = docArgv('remove', {
      scope: 'canon',
      subject: 'alpha',
      slug: '.agents/rules/docs.md',
      reason: 'obsolete',
      expectedRevision: 'revision-1',
    })
    const expectAt = argv.indexOf('--expect')
    expect(argv.filter((argument) => argument === '--expect')).toHaveLength(1)
    expect(argv.slice(expectAt, expectAt + 2)).toEqual(['--expect', 'revision-1'])
  })

  test('subjects', () => {
    expect(docArgv('subjects')).toEqual(['doc', 'subjects', '--json'])
  })
})
