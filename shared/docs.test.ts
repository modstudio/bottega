import { describe, expect, test } from 'bun:test'
import {
  DOC_SUMMARY_MAX_LENGTH,
  docAddressBelongsToProject,
  docScopeIsProjectless,
  docSummary,
  normalizeDocAudiences,
  normalizeDocSummary,
} from './docs.ts'

describe('normalizeDocAudiences', () => {
  test('refuses empty, duplicate, and unknown sets and orders valid input', () => {
    expect(() => normalizeDocAudiences([])).toThrow('must not be empty')
    expect(() => normalizeDocAudiences(['internal', 'internal'])).toThrow('duplicate')
    expect(() => normalizeDocAudiences(['user'])).toThrow(
      'valid audiences: technical, internal, customer',
    )
    expect(normalizeDocAudiences(['customer', 'technical'])).toEqual(['technical', 'customer'])
  })
})

describe('docSummary', () => {
  test('skips front matter and a leading heading', () => {
    expect(docSummary('---\nstatus: open\n---\n# Install\n\nThe first paragraph.')).toBe(
      'The first paragraph.',
    )
  })
  test('does not take lists or code fences as prose', () => {
    expect(docSummary('- item\n\n```ts\nconst x = 1\n```\n\nUseful prose.')).toBe('Useful prose.')
  })
  test('strips inline markdown', () => {
    expect(docSummary('Use **strong**, `code`, and [the guide](/docs).')).toBe(
      'Use strong, code, and the guide.',
    )
  })
  test('truncates at a word boundary', () => {
    const text = `${'word '.repeat(40)}finish`
    const summary = docSummary(text)
    expect(summary.endsWith('…')).toBe(true)
    expect(summary.length).toBeLessThanOrEqual(DOC_SUMMARY_MAX_LENGTH + 1)
    expect(summary.slice(0, -1).endsWith(' ')).toBe(false)
  })
  test('is empty without prose', () => expect(docSummary('# Heading\n\n- item\n')).toBe(''))
})

describe('normalizeDocSummary', () => {
  test('trims, treats empty as none, and refuses multiline and oversized values', () => {
    expect(normalizeDocSummary('  Written copy.  ')).toBe('Written copy.')
    expect(normalizeDocSummary('   ')).toBeNull()
    expect(() => normalizeDocSummary('one\ntwo')).toThrow('summary must be a single line')
  })
})

describe('docScopeIsProjectless', () => {
  test('is true only for scopes that declare no subject kind', () => {
    expect(docScopeIsProjectless('global')).toBe(true)
    expect(docScopeIsProjectless('machine')).toBe(true)
    expect(docScopeIsProjectless('project')).toBe(false)
    expect(docScopeIsProjectless('stack')).toBe(false)
  })
})

describe('docAddressBelongsToProject', () => {
  test('accepts a project-less document on any project', () => {
    expect(
      docAddressBelongsToProject({ scope: 'global', subject: null, projectName: null }, 'fixture'),
    ).toBe(true)
  })
  test('accepts a document scoped to the project itself', () => {
    expect(
      docAddressBelongsToProject(
        { scope: 'project', subject: 'fixture', projectName: 'fixture' },
        'fixture',
      ),
    ).toBe(true)
    expect(
      docAddressBelongsToProject(
        { scope: 'resume', subject: 'fixture', projectName: null },
        'fixture',
      ),
    ).toBe(true)
  })
  test('refuses a document scoped to another project', () => {
    expect(
      docAddressBelongsToProject(
        { scope: 'project', subject: 'other', projectName: 'other' },
        'fixture',
      ),
    ).toBe(false)
    expect(
      docAddressBelongsToProject(
        { scope: 'resume', subject: 'other', projectName: null },
        'fixture',
      ),
    ).toBe(false)
  })
})
