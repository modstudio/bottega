import { expect, test } from 'bun:test'
import type { DocRow } from './orch.ts'
import { writeNoteEvaluationRecord } from './orch.ts'
import type { DocSetInput } from './orch-doc-argv.ts'

const row = (revision: string): DocRow => ({
  record_id: '01990000-0000-7000-8000-000000000001',
  scope: 'project',
  subject: 'alpha',
  slug: 'note-evaluation',
  title: 'Note evaluation: alpha',
  body: 'body',
  delivery: 'demand',
  audiences: ['technical'],
  parent_record_id: null,
  parent_slug: null,
  position: 0,
  kind: 'working',
  revision,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
})

test('writes the ruled document shape and revises the current record', async () => {
  const writes: DocSetInput[] = []
  const current = row('revision-1')
  await writeNoteEvaluationRecord('alpha', 'evaluation', {
    list: async () => [current],
    set: async (input) => {
      writes.push(input)
      return row('revision-2')
    },
  })
  expect(writes).toEqual([
    {
      scope: 'project',
      subject: 'alpha',
      slug: 'note-evaluation',
      title: 'Note evaluation: alpha',
      body: 'evaluation',
      reason: 'record the current note backlog evaluation',
      delivery: 'demand',
      kind: 'working',
      expectedRevision: 'revision-1',
    },
  ])
})
