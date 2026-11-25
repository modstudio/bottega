import { expect, spyOn, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import * as hubNotes from '../mcp/hub-notes.ts'
import { assertPlanTaskNoteProvenance } from './workflow-cursor-compose.ts'
import { gatherNoteArtifactEvidence } from './workflow-floor-note-evidence.ts'
import { productionWorkflowFloorPorts } from './workflow-production-floor-ports.ts'

test('note evidence accepts a note sighted after step activation', async () => {
  const recordId = newRecordId()
  const list = spyOn(hubNotes, 'findHubNote').mockResolvedValue({
    record_id: recordId,
    label: 'fixture#1',
    text: 'fixture note',
    stale_at: null,
    stale_reason: null,
    promoted_task: null,
    created_at: '2026-08-01T00:00:00.000Z',
    last_seen_at: '2026-09-02T00:00:00.000Z',
  })

  try {
    await expect(
      gatherNoteArtifactEvidence(
        { kind: 'note', reference: recordId },
        `note:${recordId}`,
        'fixture',
        '2026-09-01T00:00:00.000Z',
        'DEV-977',
        false,
        productionWorkflowFloorPorts(),
      ),
    ).resolves.toMatchObject({
      note: { recordId, writtenAt: '2026-09-02T00:00:00.000Z' },
    })
  } finally {
    list.mockRestore()
  }
})

test('note evidence refuses an old note with the sighting command', async () => {
  const recordId = newRecordId()
  const list = spyOn(hubNotes, 'findHubNote').mockResolvedValue({
    record_id: recordId,
    label: 'fixture#1',
    text: 'fixture note',
    stale_at: null,
    stale_reason: null,
    promoted_task: null,
    created_at: '2026-08-01T00:00:00.000Z',
    last_seen_at: '2026-08-02T00:00:00.000Z',
  })

  try {
    await expect(
      gatherNoteArtifactEvidence(
        { kind: 'note', reference: recordId },
        `note:${recordId}`,
        'fixture',
        '2026-09-01T00:00:00.000Z',
        'DEV-977',
        false,
        productionWorkflowFloorPorts(),
      ),
    ).rejects.toThrow(
      `${PLATFORM_SLUG} note new --same-as fixture#1 --project fixture "<sighting>"`,
    )
  } finally {
    list.mockRestore()
  }
})

test('promoted note evidence returns only notes promoted to the cursor task', async () => {
  const promotedRecordId = newRecordId()
  const otherRecordId = newRecordId()
  const list = spyOn(hubNotes, 'listHubNotesPromotedTo').mockResolvedValue([
    {
      record_id: promotedRecordId,
      label: 'fixture#1',
      text: 'promoted note',
      stale_at: null,
      stale_reason: null,
      promoted_task: 'DEV-977',
      created_at: '2026-08-01T00:00:00.000Z',
      last_seen_at: '2026-08-01T00:00:00.000Z',
    },
    {
      record_id: otherRecordId,
      label: 'fixture#2',
      text: 'other note',
      stale_at: '2026-09-01T00:00:00.000Z',
      stale_reason: 'gone',
      promoted_task: 'DEV-978',
      created_at: '2026-08-01T00:00:00.000Z',
      last_seen_at: '2026-08-01T00:00:00.000Z',
    },
  ])

  try {
    await expect(
      productionWorkflowFloorPorts().listPromotedNotes?.('fixture', 'DEV-977'),
    ).resolves.toEqual([{ recordId: promotedRecordId, label: 'fixture#1', staleAt: null }])
  } finally {
    list.mockRestore()
  }
})

test('interactive note reads each spawn one filtered slim-list command', async () => {
  const calls: string[][] = []
  const liveId = newRecordId()
  const staleId = newRecordId()
  const rows = [
    {
      record_id: liveId,
      label: 'fixture#1',
      text: 'live promoted note',
      stale_at: null,
      stale_reason: null,
      promoted_task: 'DEV-977',
      created_at: '2026-08-01T00:00:00.000Z',
      last_seen_at: '2026-09-02T00:00:00.000Z',
    },
    {
      record_id: staleId,
      label: 'fixture#2',
      text: 'stale promoted note',
      stale_at: '2026-09-01T00:00:00.000Z',
      stale_reason: 'branch gone',
      promoted_task: 'DEV-977',
      created_at: '2026-08-01T00:00:00.000Z',
      last_seen_at: '2026-08-02T00:00:00.000Z',
    },
  ]
  const output: hubNotes.HubNoteOutput = async (args) => {
    calls.push(args)
    return JSON.stringify(args.includes('--reference') ? [rows[0]] : rows)
  }
  const ports = productionWorkflowFloorPorts(output)

  await expect(ports.readNote?.('fixture', liveId)).resolves.toMatchObject({ recordId: liveId })
  await expect(ports.listPromotedNotes?.('fixture', 'DEV-977')).resolves.toEqual([
    { recordId: liveId, label: 'fixture#1', staleAt: null },
    { recordId: staleId, label: 'fixture#2', staleAt: '2026-09-01T00:00:00.000Z' },
  ])
  await expect(
    assertPlanTaskNoteProvenance(
      {
        workflow: { slug: 'plan-task' },
        project: 'fixture',
        arguments: { key: 'DEV-977' },
      } as unknown as Parameters<typeof assertPlanTaskNoteProvenance>[0],
      (project, key, options) =>
        hubNotes.listHubNotesPromotedTo(project, key, { ...options, output }),
    ),
  ).rejects.toThrow('task DEV-977 was promoted from note fixture#1')
  await expect(hubNotes.hubNoteLabel(liveId, { cwd: process.cwd(), output })).resolves.toBe(
    'fixture#1',
  )

  expect(calls).toHaveLength(4)
  for (const args of calls) {
    expect(args.slice(0, 2)).toEqual(['note', 'list'])
    expect(args.filter((arg) => arg === '--promoted-to' || arg === '--reference')).toHaveLength(1)
  }
  expect(calls[3]).not.toContain('--project')
  expect(calls[3]).not.toContain('--stale')
})
