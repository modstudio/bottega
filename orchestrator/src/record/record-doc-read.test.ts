import { expect, test } from 'bun:test'
import type { RecordDocRevision } from './record-doc-mapping.ts'
import { hostedDocBodyForAudience, recordDocRevisionHistoryForAudience } from './record-doc-read.ts'

const revision: RecordDocRevision = {
  id: '01990000-0000-7000-8000-000000000001',
  docId: '01990000-0000-7000-8000-000000000002',
  scope: 'project',
  subject: 'workshop',
  owner: null,
  slug: 'agreement',
  op: 'set',
  title: 'Agreement',
  body: ':::section{audience="technical"}\nTechnical\n:::',
  withheldForAudience: false,
  delivery: 'demand',
  audiences: ['technical'],
  parentId: null,
  position: 0,
  author: 'editor',
  authorName: null,
  reason: 'Clarify it',
  sessionId: null,
  at: '2026-10-12T12:00:00.000Z',
}

test('the hosted audience helper refuses then projects', () => {
  expect(() => hostedDocBodyForAudience(revision, 'internal')).toThrow(
    'document project/workshop/agreement does not list audience "internal"; choose one of technical',
  )
  expect(hostedDocBodyForAudience(revision, 'technical')).toBe('Technical\n')
})

test('mixed-audience history keeps every row and refuses only from the live document', () => {
  const internal: RecordDocRevision = {
    ...revision,
    id: '01990000-0000-7000-8000-000000000003',
    body: 'Internal body',
    audiences: ['internal'],
  }
  expect(recordDocRevisionHistoryForAudience(internal, [internal, revision], 'internal')).toEqual([
    internal,
    { ...revision, body: '', withheldForAudience: true },
  ])
  expect(() =>
    recordDocRevisionHistoryForAudience(revision, [internal, revision], 'internal'),
  ).toThrow(
    'document project/workshop/agreement does not list audience "internal"; choose one of technical',
  )
})
