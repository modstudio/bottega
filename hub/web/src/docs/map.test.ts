import { expect, test } from 'bun:test'
import { mapDoc } from './map.ts'

const article = {
  form: 'overview' as const,
  articleSubject: { id: 'subject-1', name: 'Routing' },
  relatedSubjects: [
    { id: 'subject-2', name: 'Evidence' },
    { id: 'subject-3', name: 'Review' },
  ],
  sourceFiles: ['orchestrator/src/route.ts', 'orchestrator/src/evidence.ts'],
}

function contractRow(id: string | number) {
  return {
    id,
    slug: 'routing',
    title: 'Routing',
    parentId: null,
    position: 0,
    updatedAt: '2026-10-11T00:00:00.000Z',
    scope: 'project',
    subject: 'starship',
    audiences: ['technical'],
    status: 'current',
    replacementSlug: null,
    body: 'Body.',
    ...article,
  }
}

test.each([
  ['the local contract', contractRow(1)],
  ['the signed contract', contractRow('10000000-0000-4000-8000-000000000000')],
])('the mapping carries article fields from %s', (_name, row) => {
  const mapped = mapDoc(row)
  expect(mapped.form).toBe(article.form)
  expect(mapped.articleSubject).toEqual(article.articleSubject)
  expect(mapped.relatedSubjects).toEqual(article.relatedSubjects)
  expect(mapped.sourceFiles).toEqual(article.sourceFiles)
})
