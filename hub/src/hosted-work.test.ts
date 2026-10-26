import { expect, test } from 'bun:test'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import { hostedBoard, hostedDayRow, interval, parseHostedIntervalRows } from './hosted-work.ts'

const DAY_TOKENS = 8_338_668_790
const INTERVAL_TOKENS = 2_207_932_949

function expectNumber(value: unknown, expected: number) {
  expect(typeof value).toBe('number')
  expect(value).toBe(expected)
}

test('hosted work rows return token totals above the 32-bit range as numbers', () => {
  const intervalRow = {
    task_key: 'DEV-1240',
    project: 'workshop',
    source: 'claude',
    agent: null,
    job: null,
    start_at: '2026-10-05T10:00:00.000Z',
    end_at: '2026-10-05T12:00:00.000Z',
    vendor_cost_usd: null,
    open: 0,
  }
  for (const tokens of [String(INTERVAL_TOKENS), BigInt(INTERVAL_TOKENS), INTERVAL_TOKENS]) {
    const shapedInterval = interval({
      ...intervalRow,
      claude_tokens: tokens,
      vendor_tokens: tokens,
    })
    expectNumber(shapedInterval.claude_tokens, INTERVAL_TOKENS)
    expectNumber(shapedInterval.vendor_tokens, INTERVAL_TOKENS)
  }

  const dayRow = {
    day: '2026-10-05',
    tasks: 1,
    commits: 0,
    files: 0,
    lines_product: 0,
    lines_test: 0,
    lines_docs: 0,
    lines_config: 0,
    lines_generated: 0,
  }
  for (const tokens of [String(DAY_TOKENS), BigInt(DAY_TOKENS), DAY_TOKENS]) {
    expectNumber(hostedDayRow({ ...dayRow, claude_tokens: tokens }).claude_tokens, DAY_TOKENS)
  }
})

test('hosted task interval edge parser accepts an unattributed project', () => {
  expect(
    parseHostedIntervalRows([
      {
        id: null,
        task_key: 'DEV-1385',
        project: null,
        source: 'codex',
        agent: null,
        job: null,
        start_at: '2026-10-17T00:00:00.000Z',
        end_at: '2026-10-17T01:00:00.000Z',
        claude_tokens: 0,
        vendor_tokens: 0,
        vendor_cost_usd: null,
        open: 0,
        user_id: null,
      },
    ]),
  ).toHaveLength(1)
})

test('hosted board attributes intervals only through task UUID and uses the task card identity', async () => {
  const spaceId = '01990000-0000-7000-8000-000000001600'
  const userId = '01990000-0000-7000-8000-000000001601'
  const projectId = '01990000-0000-7000-8000-000000001602'
  const linkedTaskId = '01990000-0000-7000-8000-000000001603'
  const labelOnlyTaskId = '01990000-0000-7000-8000-000000001604'
  const database = await createHostedRecordFixture({ spaceId, userId })
  const yesterday = new Date(Date.now() - 86_400_000)
  const startAt = new Date(yesterday.getTime() - 60_000).toISOString()
  const endAt = yesterday.toISOString()
  try {
    await database.query(
      `INSERT INTO project(id,space_id,name,created_at) VALUES ($1,$2,'workshop',now())`,
      [projectId, spaceId],
    )
    await database.query(
      `INSERT INTO hub_task
       (id,space_id,key,project,project_name,project_id,title,status,status_category,source,
        first_seen,last_seen,created_at,updated_at,next_document_number)
       VALUES
       ($1,$3,'DEV-1','workshop','workshop',$4,'Linked','todo','open','mcp',now(),now(),now(),now(),1),
       ($2,$3,'DEV-2','workshop','workshop',$4,'Label only','todo','open','mcp',now(),now(),now(),now(),1)`,
      [linkedTaskId, labelOnlyTaskId, spaceId, projectId],
    )
    await database.query(
      `INSERT INTO hub_interval
       (id,space_id,task_key,task_id,project_name,project_id,source,start_at,end_at,ref,updated_at)
       VALUES
       ('01990000-0000-7000-8000-000000001605',$1,'DEV-1',$2,'workshop',$3,'orch',$4,$5,'linked',now()),
       ('01990000-0000-7000-8000-000000001606',$1,'DEV-2',NULL,'workshop',$3,'orch',$4,$5,'label-only',now())`,
      [spaceId, linkedTaskId, projectId, startAt, endAt],
    )

    const page = await hostedBoard(
      pgliteSql(database),
      { userId, spaceId },
      {
        hours: 720,
        filters: { agent: '', project: '', source: '' },
        projects: [{ spaceId, spaceName: 'Mirror test', name: 'workshop', keyPrefixes: ['DEV'] }],
      },
    )

    expect(page.data.cards.map((card) => card.recordId)).toEqual([linkedTaskId])
    expect(page.data.cards[0]?.key).toBe('DEV-1')
  } finally {
    await database.close()
  }
})
