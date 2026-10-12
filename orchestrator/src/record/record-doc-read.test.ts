import { expect, test } from 'bun:test'
import type { RecordDocRevision } from './record-doc-mapping.ts'
import { recordDocRevisionForAudience } from './record-doc-read.ts'

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
  delivery: 'demand',
  audiences: ['technical'],
  parentId: null,
  position: 0,
  author: 'editor',
  reason: 'Clarify it',
  sessionId: null,
  at: '2026-10-12T12:00:00.000Z',
}

test('a hosted revision refuses an audience it does not carry', () => {
  expect(() => recordDocRevisionForAudience(revision, 'internal')).toThrow(
    'document project/workshop/agreement does not list audience "internal"; choose one of technical',
  )
  expect(recordDocRevisionForAudience(revision, 'technical').body).toBe('Technical\n')
})
