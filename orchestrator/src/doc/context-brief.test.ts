import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { encodeContextItem } from './context-item-codec.ts'
import {
  type ContextBrief,
  holderSequence,
  renderContextBrief,
  storedBriefHolders,
} from './context-brief.ts'

const item = (
  holder: string,
  id: string,
  kind: ContextBrief['holders'][number]['items'][number]['kind'],
  body: string,
  source = 'task-doc',
) => ({ holder, id, kind, body, source })

test('renders the compact context layout line by line and keeps only item first lines', () => {
  const brief: ContextBrief = {
    session: '65fbe830',
    fullCommand: `${PLATFORM_SLUG} agent context show --task DEV-1844/2`,
    holders: [
      {
        key: '65fbe830',
        title: '',
        kind: 'session',
        items: [item('session:65fbe830', 'weekend', 'fact', 'work autonomously\rthrough Sunday')],
      },
      {
        key: 'DEV-1844/2',
        title: 'Build the brief',
        kind: 'task',
        items: [
          item('task:DEV-1844/2', 'next', 'next-action', 'implement the renderer'),
          item('task:DEV-1844/2', 'pointer', 'pointer', 'design section 4\nignore this line'),
        ],
      },
      {
        key: 'DEV-1844',
        title: 'Architect context',
        kind: 'epic',
        items: [
          item(
            'task:DEV-1844',
            'approved',
            'ruling',
            'Approved as proposed\r\nwith detail',
            'q5282',
          ),
        ],
      },
    ],
    runs: [
      { number: 31110, job: 'implement', status: 'running' },
      { number: 31111, job: 'review', status: 'asking' },
    ],
    cursors: [{ number: 1369, workflow: 'plan-task', mode: 'design', questionNumber: 5277 }],
    claims: [{ kind: 'task', value: 'DEV-1844/2' }],
    waiting: { boardRequests: 2, questions: 0, filedIssues: 3, resumeBriefs: 1 },
    autonomy: 'plan review · implement, review, docs, canon auto · ship trunk',
  }

  expect(renderContextBrief(brief).split('\n')).toEqual([
    `Context (session 65fbe830) · full: ${PLATFORM_SLUG} agent context show --task DEV-1844/2`,
    'Session 65fbe830',
    '  fact: work autonomously',
    '  open: none',
    'DEV-1844/2 Build the brief',
    '  next: implement the renderer',
    '  pointer: design section 4',
    '  open: none',
    'DEV-1844 Architect context',
    '  ruling q5282: "Approved as proposed"',
    '  open: none',
    'In flight: run 31110 implement running · run 31111 review asking · cursor 1369 plan-task design, awaiting q5277 · claim task:DEV-1844/2',
    `Waiting: 2 board requests (${PLATFORM_SLUG} board read) · 0 questions · 3 filed issues (${PLATFORM_SLUG} workflow fix-defect --waiting) · 1 resume brief (${PLATFORM_SLUG} doc resumes)`,
    'Autonomy: plan review · implement, review, docs, canon auto · ship trunk',
  ])
})

test('orders the session, each project-scoped working task, and its epic by task profile', () => {
  const task = (key: string, project: string, title: string, parentKey: string | null = null) => ({
    key,
    project,
    title,
    parent_key: parentKey,
    record_id: `${project}:${key}`,
  })
  const tasks = [
    task('DEV-1844/2', PLATFORM_SLUG, 'Build the brief', 'DEV-1844'),
    task('DEV-1844', PLATFORM_SLUG, 'Architect context'),
    task('APP-7', 'other', 'Other project task'),
    task('DEV-2000', PLATFORM_SLUG, 'Parentless childless task'),
    task('SHARED-1', PLATFORM_SLUG, 'Platform shared key'),
    task('SHARED-1', 'other', 'Other shared key'),
  ]

  expect(
    holderSequence(
      '65fbe830',
      [
        { key: 'DEV-1844/2', project: PLATFORM_SLUG },
        { key: 'APP-7', project: 'other' },
        { key: 'DEV-2000', project: PLATFORM_SLUG },
        { key: 'SHARED-1', project: PLATFORM_SLUG },
        { key: 'SHARED-1', project: 'other' },
      ],
      tasks,
    ),
  ).toEqual([
    { key: '65fbe830', title: '', kind: 'session', recordId: null },
    {
      key: 'DEV-1844/2',
      title: 'Build the brief',
      kind: 'task',
      recordId: `${PLATFORM_SLUG}:DEV-1844/2`,
    },
    {
      key: 'DEV-1844',
      title: 'Architect context',
      kind: 'epic',
      recordId: `${PLATFORM_SLUG}:DEV-1844`,
    },
    { key: 'APP-7', title: 'Other project task', kind: 'task', recordId: 'other:APP-7' },
    {
      key: 'DEV-2000',
      title: 'Parentless childless task',
      kind: 'task',
      recordId: `${PLATFORM_SLUG}:DEV-2000`,
    },
    {
      key: 'SHARED-1',
      title: 'Platform shared key',
      kind: 'task',
      recordId: `${PLATFORM_SLUG}:SHARED-1`,
    },
    {
      key: 'SHARED-1',
      title: 'Other shared key',
      kind: 'task',
      recordId: 'other:SHARED-1',
    },
  ])
})

test('reads a working task brief from its record-id holder while retaining the task key', () => {
  const recordId = newRecordId()
  const body = encodeContextItem({ kind: 'next-action', source: 'test', body: 'Continue.' })
  db()
    .query(
      `INSERT INTO doc
       (record_id,scope,subject,slug,title,body,delivery,audiences,created_at,updated_at)
       VALUES (?,'context',?,'next','next',?,'demand','["technical"]',?,?)`,
    )
    .run(newRecordId(), `task:${recordId}`, body, '2026-11-09T10:00:00Z', '2026-11-09T10:00:00Z')
  const references = holderSequence(
    'session-id',
    [{ key: 'STAR-1', project: 'starship' }],
    [{ key: 'STAR-1', project: 'starship', record_id: recordId, title: 'Stable holder' }],
  )
  expect(storedBriefHolders(references, db())).toEqual([
    {
      key: 'STAR-1',
      title: 'Stable holder',
      kind: 'task',
      items: [item(`task:${recordId}`, 'next', 'next-action', 'Continue.', 'test')],
    },
  ])
})
