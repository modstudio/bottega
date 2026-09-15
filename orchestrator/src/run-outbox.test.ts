import { expect, test } from 'bun:test'
import { buildRunRecordPayload, RUN_RECORD_PAYLOAD_COLUMNS } from './run-outbox.ts'

test('terminal payload maps every hosted run column and no execution-state column', () => {
  const payload = buildRunRecordPayload(
    {
      id: 42,
      record_id: '01990000-0000-7000-8000-000000000042',
      project_name: 'project',
      started_at: '2026-09-15T01:00:00.000Z',
      retry_record_id: null,
      parent_record_id: null,
      changed_paths: '["a.ts"]',
      doc_revisions: '["revision"]',
      outside_worktree_writes: null,
      review_provenance: '{"commands_run":[]}',
    },
    '01990000-0000-7000-8000-000000000099',
    '2026-09-15T01:01:00.000Z',
  )
  expect(Object.keys(payload).sort()).toEqual([...RUN_RECORD_PAYLOAD_COLUMNS].sort())
  expect(payload).toMatchObject({
    localId: 42,
    createdAt: '2026-09-15T01:00:00.000Z',
    finishedAt: '2026-09-15T01:01:00.000Z',
    updatedAt: '2026-09-15T01:01:00.000Z',
    changedPaths: ['a.ts'],
    docRevisions: ['revision'],
    reviewProvenance: { commands_run: [] },
  })
  expect(payload).not.toHaveProperty('cwd')
  expect(payload).not.toHaveProperty('outputPath')
  expect(payload).not.toHaveProperty('vendorSession')
})
