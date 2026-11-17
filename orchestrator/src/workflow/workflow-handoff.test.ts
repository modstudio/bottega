import { expect, test } from 'bun:test'
import { setContextItem } from '../doc/context-item-store.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { handoffWorkflow } from './workflow-handoff.ts'
import {
  database,
  selectAndNextWorkflowStep,
  testPorts,
} from './workflow-cursor-test.fixture.ts'
import { promoteWorkflowLocal, setWorkflowLocal } from './workflows.ts'

function install(d: ReturnType<typeof database>, slug: string, steps: string[]) {
  const draft = setWorkflowLocal(slug, {
    title: slug,
    description: 'handoff fixture',
    arguments: [{ name: 'key', required: true, description: 'Task key.' }],
    modes: [{ slug: 'default', title: 'Default', default: true, steps }],
  }, 'handoff fixture', 'test', d)
  promoteWorkflowLocal(slug, draft.n, 'handoff fixture', 'test', d)
}

test('handoff closes the old stage, opens and links the successor, moves context, and renews the same claim', async () => {
  const d = database()
  install(d, 'handoff-source', ['score', 'rebase', 'complete'])
  install(d, 'handoff-target', ['score'])
  const args = { key: 'DEV-HANDOFF' }
  const context = { session: 'handoff-session', taskRecordId: 'task-DEV-HANDOFF', taskStatusCategory: 'active' }
  const opened = await composeWorkflowWithCursor('handoff-source', 'fixture', 'default', args, context, d, {}, {})
  const oldNumber = opened.cursor!.id
  d.query("UPDATE workflow_cursor SET enforcement='note-only' WHERE number=?").run(oldNumber)
  await selectAndNextWorkflowStep('handoff-source', 'fixture', 'default', args, 'first done', context, d, {}, testPorts)
  const old = d.query<any, [number]>('SELECT * FROM workflow_cursor WHERE number=?').get(oldNumber)!
  setContextItem({ holder: `cursor:${old.record_id}`, slug: 'decision', kind: 'fact', body: 'carry me', source: 'test' }, d)
  const claim = d.query<{ record_id: string }, [string]>("SELECT record_id FROM board_claim WHERE subject_value=? AND state='live'").get('DEV-HANDOFF')
  const takes: string[] = []
  const result = await handoffWorkflow({
    row: { ...old, id: old.number, workflow_version: 1, catalogue_version: 1, handed_off_from_record_id: null },
    workflow: 'handoff-target', mode: 'default', args, reason: 'ready to ship', context, live: {}, database: d,
    taskClaimPorts: {
      take: async ({ key }) => { takes.push(key); return { action: 'renewed', id: claim?.record_id ?? 'claim', subject: `task:${key}`, expiresAt: '' } as any },
      release: async () => ({ released: 0 }),
    },
  })
  const oldAfter = d.query<any, [number]>('SELECT * FROM workflow_cursor WHERE number=?').get(oldNumber)!
  const next = d.query<any, [number]>('SELECT * FROM workflow_cursor WHERE number=?').get(result.cursor)!
  expect(oldAfter.state).toBe('done')
  expect(JSON.parse(oldAfter.closed).map((entry: any) => entry.note)).toEqual([
    'first done',
    `handed off to handoff-target (cursor ${result.cursor}): ready to ship`,
    'not run: handed off',
  ])
  expect(next).toMatchObject({ state: 'running', ordinal: 0, handed_off_from_record_id: old.record_id, session_id: context.session })
  expect(d.query('SELECT holder_id FROM context_item WHERE slug=?').get('decision')).toEqual({ holder_id: next.record_id })
  expect(takes).toEqual(['DEV-HANDOFF'])
  expect(claim?.record_id).toBeTruthy()
})
