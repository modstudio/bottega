import { expect, test } from 'bun:test'
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import { markMonitorNoticesDelivered } from '../monitor/monitor-notices.ts'
import { projectAt } from '../project/projects.ts'
import { BOARD_BODY_MAX_CHARS, BOARD_TITLE_MAX_CHARS } from './board-policy.ts'
import {
  acknowledgeNotice,
  boardEscalations,
  claimInterruptNotices,
  claimNotices,
  claimRunNotices,
  markInterruptNoticesDelivered,
  noticeStatus,
  postNotice,
  readNotices,
  recordPresence,
} from './board-service.ts'

function postingProject() {
  const cwd = resolve(import.meta.dir, '../../..')
  db()
    .query(
      `INSERT OR IGNORE INTO project(name,path,settings)
       VALUES ('board-post-fixture',?,'{}')`,
    )
    .run(cwd)
  const project = projectAt(cwd)
  if (!project) throw new Error('board post test project did not resolve')
  return { cwd, project }
}

test('notice store round-trip resolves, renders, delivers, and explicitly acknowledges', () => {
  const clock = Date.now()
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,last_seen)
     VALUES ('board-reader','claude-code','architect','test',?,'/tmp',NULL,?)`,
    )
    .run(PLATFORM_SLUG, new Date(clock).toISOString())
  const posted = postNotice(
    { audience: 'architects', title: 'Wind down', body: 'Finish owned work.', ackRequired: true },
    {},
    clock,
  )
  const env = { CLAUDE_CODE_SESSION_ID: 'board-reader' }
  const notices = readNotices(false, env, clock + 1)
  expect(notices).toHaveLength(1)
  expect(notices[0]!.text).toContain('Origin: operator')
  expect(notices[0]!.text).toContain('not an instruction, ruling, or consent')
  expect(noticeStatus(posted.id, {}).unacknowledged).toEqual(['board-reader'])
  acknowledgeNotice(posted.id, env, clock + 2)
  expect(noticeStatus(posted.id, {}).unacknowledged).toEqual([])
})

test('recordPresence preserves first_seen after the first insert', () => {
  const { cwd } = postingProject()
  const env = { CLAUDE_CODE_SESSION_ID: 'presence-first-seen' }
  recordPresence(cwd, env, '2026-10-05T11:00:00.000Z')
  recordPresence(cwd, env, '2026-10-05T12:00:00.000Z')
  expect(
    db().query('SELECT first_seen,last_seen FROM presence WHERE session_id=?').get(env.CLAUDE_CODE_SESSION_ID),
  ).toEqual({ first_seen: '2026-10-05T11:00:00.000Z', last_seen: '2026-10-05T12:00:00.000Z' })
})

test('tagged project notice follows matching run paths at posting and for a late session', () => {
  const clock = Date.now() + 10_000
  const project = 'board-routing-project'
  const insertPresence = db().query(
    `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,last_seen)
     VALUES (?,'claude-code','architect','test',?,'/tmp',NULL,?)`,
  )
  const insertRun = db().query(
    `INSERT INTO run
     (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,session_id,changed_paths)
     VALUES (?,'codex','implement','sha',1,'prompt','ok',?,?)`,
  )
  for (const [session, paths] of [
    ['matching-reader', ['orchestrator/src/board/board-service.ts']],
    ['other-reader', ['hub/web/src/routes/index.tsx']],
  ] as const) {
    insertPresence.run(session, project, new Date(clock).toISOString())
    insertRun.run(new Date(clock).toISOString(), session, JSON.stringify(paths))
  }
  const posted = postNotice(
    {
      audience: `project:${project}`,
      title: 'Board work',
      body: 'The board service changed.',
      paths: ['orchestrator/src/board/**'],
    },
    {},
    clock,
  )
  expect(posted.reached).toBe(1)
  const matchingNotices = claimNotices(
    false,
    { CLAUDE_CODE_SESSION_ID: 'matching-reader' },
    clock + 1,
  )
  expect(matchingNotices.map((notice) => notice.id)).toEqual([posted.id])
  expect(matchingNotices[0]!.text).toContain('Tags: path:orchestrator/src/board/**')
  expect(claimNotices(false, { CLAUDE_CODE_SESSION_ID: 'other-reader' }, clock + 1)).toEqual([])

  insertPresence.run('late-reader', project, new Date(clock + 2).toISOString())
  insertRun.run(
    new Date(clock + 2).toISOString(),
    'late-reader',
    JSON.stringify(['orchestrator/src/board/board-routing.ts']),
  )
  expect(
    claimNotices(false, { CLAUDE_CODE_SESSION_ID: 'late-reader' }, clock + 3).map(
      (notice) => notice.id,
    ),
  ).toEqual([posted.id])
  readNotices(false, { CLAUDE_CODE_SESSION_ID: 'late-reader' }, clock + 4)
  expect(noticeStatus(posted.id, {}).reached).toBe(2)
})

test('tagged project notice reaches a matching worker chain and withholds from another', () => {
  const clock = Date.now() + 12_000
  const insertRun = db().query(
    `INSERT INTO run
     (started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,launch_key,changed_paths,parent_run_id,turn)
     VALUES (?,'codex','implement','worker-board-project','sha',1,'prompt',?,?,?,?,?) RETURNING id`,
  )
  const matching = insertRun.get(
    new Date(clock).toISOString(),
    'running',
    'DEV-MATCH',
    JSON.stringify(['orchestrator/src/board/board-service.ts']),
    null,
    1,
  ) as { id: number }
  const other = insertRun.get(
    new Date(clock).toISOString(),
    'asking',
    'DEV-OTHER',
    JSON.stringify(['hub/web/src/routes/index.tsx']),
    null,
    1,
  ) as { id: number }
  const posted = postNotice(
    {
      audience: 'project:worker-board-project',
      title: 'Matching worker',
      body: 'Only matching task context receives this.',
      task: 'DEV-MATCH',
    },
    {},
    clock,
  )
  expect(posted.reached).toBe(1)
  expect(claimRunNotices(matching.id, false, clock + 1).map((notice) => notice.id)).toEqual([
    posted.id,
  ])
  expect(claimRunNotices(other.id, false, clock + 1)).toEqual([])
})

test('run audience is owner-gated for architects and resolves a turn to its chain root', () => {
  const clock = Date.now() + 13_000
  const posting = postingProject()
  const insertRun = db().query(
    `INSERT INTO run
     (started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,session_id,parent_run_id,turn)
     VALUES (?,'codex','implement','owned-run-project','sha',1,'prompt','running',?,?,?) RETURNING id`,
  )
  const root = insertRun.get(new Date(clock).toISOString(), 'run-owner', null, 1) as { id: number }
  const turn = insertRun.get(new Date(clock + 1).toISOString(), 'run-owner', root.id, 2) as {
    id: number
  }

  const owned = postNotice(
    { audience: `run:${turn.id}`, title: 'Owner notice', body: 'Addressed through a turn.' },
    { CLAUDE_CODE_SESSION_ID: 'run-owner' },
    clock + 2,
    posting.cwd,
  )
  expect(owned.reached).toBe(1)
  expect(claimRunNotices(root.id, false, clock + 3).map((notice) => notice.id)).toContain(owned.id)

  const before = (db().query('SELECT COUNT(*) count FROM board_message').get() as { count: number })
    .count
  expect(() =>
    postNotice(
      { audience: `run:${turn.id}`, title: 'Foreign notice', body: 'Must not be stored.' },
      { CLAUDE_CODE_SESSION_ID: 'foreign-architect' },
      clock + 4,
      posting.cwd,
    ),
  ).toThrow(
    'run ' +
      turn.id +
      ' is owned by session run-owner; address project:<name> or workers:<project>, or ask the owner',
  )
  expect(db().query('SELECT COUNT(*) count FROM board_message').get()).toEqual({ count: before })

  const operator = postNotice(
    { audience: `run:${turn.id}`, title: 'Operator notice', body: 'Operator may address any run.' },
    {},
    clock + 5,
  )
  expect(operator.reached).toBe(1)
})

test('an unregistered live chain resolves for run and machine but not project audiences', () => {
  const clock = Date.now() + 14_000
  const run = db()
    .query(
      `INSERT INTO run
       (started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,turn)
       VALUES (?,'codex','implement',NULL,'sha',1,'prompt','asking',1) RETURNING id`,
    )
    .get(new Date(clock).toISOString()) as { id: number }
  const byMachine = postNotice(
    { audience: `machine:${hostname()}`, title: 'Machine notice', body: 'Includes local runs.' },
    {},
    clock + 1,
  )
  const byRun = postNotice(
    { audience: `run:${run.id}`, title: 'Run notice', body: 'Includes the exact chain.' },
    {},
    clock + 2,
  )
  const byProject = postNotice(
    { audience: 'project:missing-project', title: 'Project notice', body: 'Must not match.' },
    {},
    clock + 3,
  )
  const byWorkers = postNotice(
    { audience: 'workers:missing-project', title: 'Workers notice', body: 'Must not match.' },
    {},
    clock + 4,
  )
  const ids = claimRunNotices(run.id, false, clock + 5).map((notice) => notice.id)
  expect(ids).toContain(byMachine.id)
  expect(ids).toContain(byRun.id)
  expect(ids).not.toContain(byProject.id)
  expect(ids).not.toContain(byWorkers.id)
})

test('an untagged notice infers no tags', () => {
  const posted = postNotice(
    {
      audience: 'operator',
      title: 'No context',
      body: 'Even a quoted `orchestrator/src/board/board-service.ts` stays untagged.',
    },
    {},
    Date.now() + 15_000,
  )
  expect(db().query('SELECT * FROM board_message_tag WHERE message_id=?').all(posted.id)).toEqual(
    [],
  )
})

test('duplicate notices require the same order-independent sender tag set', () => {
  const clock = Date.now() + 17_000
  const input = {
    audience: 'project:board-duplicate-tags',
    title: 'Retarget this notice',
    body: 'No live session initially matches.',
  }
  const first = postNotice(
    { ...input, paths: ['orchestrator/src/first/**'], topics: ['gate', 'infra'] },
    {},
    clock,
  )
  expect(first.reached).toBe(0)
  expect(first.dropped).toBeFalse()
  expect(first.warning).toBe(
    'reached no live session; re-address it or wait for a matching session',
  )

  const retargeted = postNotice(
    { ...input, paths: ['orchestrator/src/second/**'], topics: ['gate', 'infra'] },
    {},
    clock + 1,
  )
  expect(retargeted.id).not.toBe(first.id)
  expect(retargeted.reached).toBe(0)
  expect(retargeted.dropped).toBeFalse()

  const duplicate = postNotice(
    { ...input, paths: ['orchestrator/src/second/**'], topics: ['infra', 'gate'] },
    {},
    clock + 2,
  )
  expect(duplicate).toEqual({
    id: retargeted.id,
    dropped: true,
    reached: 0,
    warning: 'reached no live session; re-address it or wait for a matching session',
  })
})

test('a session-start notice dropped for budget stays unread until a stamping read', () => {
  const clock = Date.now() + 20_000
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,last_seen)
       VALUES ('budget-reader','claude-code','architect','test',?,'/tmp',NULL,?)`,
    )
    .run(PLATFORM_SLUG, new Date(clock).toISOString())
  const posted = postNotice(
    { audience: `session:budget-reader`, title: 'Droppable', body: 'budget text '.repeat(20) },
    {},
    clock,
  )
  const env = { CLAUDE_CODE_SESSION_ID: 'budget-reader' }
  expect(claimNotices(false, env, clock + 1).map((notice) => notice.id)).toEqual([posted.id])
  // The hook drops the whole board section here and therefore does not stamp its claimed ids.
  expect(readNotices(false, env, clock + 2).map((notice) => notice.id)).toEqual([posted.id])
})

test('architect post resolves its current cwd project, refreshes stale presence, and snapshots it', () => {
  const clock = Date.now() + 30_000
  const session = 'origin-author'
  const posting = postingProject()
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,last_seen)
       VALUES (?,'claude-code','architect','test','stale-project','/tmp',NULL,?)`,
    )
    .run(session, new Date(clock).toISOString())
  const posted = postNotice(
    { audience: 'operator', title: 'Stable origin', body: 'The origin does not move.' },
    { CLAUDE_CODE_SESSION_ID: session },
    clock,
    posting.cwd,
  )
  expect(db().query('SELECT project,cwd FROM presence WHERE session_id=?').get(session)).toEqual({
    project: posting.project.name,
    cwd: posting.cwd,
  })
  db().query('DELETE FROM presence WHERE session_id=?').run(session)
  const rendered = noticeStatus(posted.id, {}).message.text
  expect(rendered).toContain(`architect ${session} (claude-code, ${posting.project.name})`)
  expect(rendered).not.toContain('stale-project')
  expect(rendered).not.toContain('unknown project')
})

test('architect posting outside a registered project is refused with a remedy', () => {
  expect(() =>
    postNotice(
      { audience: 'operator', title: 'No project', body: 'Cannot establish origin.' },
      { CLAUDE_CODE_SESSION_ID: 'missing-project-author' },
      Date.now() + 40_000,
      '/definitely/not/a/registered/project',
    ),
  ).toThrow(/post from a registered project or run orch project add first/)
})

test('secret-shaped title or body is refused before storage without echoing it', () => {
  const planted = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'
  const before = (db().query('SELECT COUNT(*) count FROM board_message').get() as { count: number })
    .count
  for (const input of [
    { audience: 'operator', title: planted, body: 'safe' },
    { audience: 'operator', title: 'safe', body: planted },
  ]) {
    let output = ''
    try {
      postNotice(input, {}, Date.now() + 50_000)
    } catch (error) {
      output = String(error)
    }
    expect(output).toContain('secret-shaped')
    expect(output).not.toContain(planted)
  }
  const after = (db().query('SELECT COUNT(*) count FROM board_message').get() as { count: number })
    .count
  expect(after).toBe(before)
  expect(
    db().query('SELECT id FROM board_message WHERE title=? OR body=?').all(planted, planted),
  ).toEqual([])
})

test('secret-shaped sender tag values are refused before storage without echoing them', () => {
  const planted = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'
  const before = (db().query('SELECT COUNT(*) count FROM board_message').get() as { count: number })
    .count
  for (const tags of [{ task: planted }, { paths: [planted] }, { topics: [planted] }]) {
    let output = ''
    try {
      postNotice(
        { audience: 'operator', title: 'safe', body: 'safe', ...tags },
        {},
        Date.now() + 55_000,
      )
    } catch (error) {
      output = String(error)
    }
    expect(output).toContain('board notice tag contains secret-shaped text')
    expect(output).toContain('remove the credential and retry')
    expect(output).not.toContain(planted)
  }
  const after = (db().query('SELECT COUNT(*) count FROM board_message').get() as { count: number })
    .count
  expect(after).toBe(before)
})

test('post content accepts exact size boundaries and refuses one character over', () => {
  const clock = Date.now() + 60_000
  const posted = postNotice(
    {
      audience: 'operator',
      title: 't'.repeat(BOARD_TITLE_MAX_CHARS),
      body: 'z'.repeat(BOARD_BODY_MAX_CHARS),
    },
    {},
    clock,
  )
  expect(posted.dropped).toBeFalse()
  expect(() =>
    postNotice(
      { audience: 'operator', title: 't'.repeat(BOARD_TITLE_MAX_CHARS + 1), body: 'safe' },
      {},
      clock + 1,
    ),
  ).toThrow(`${BOARD_TITLE_MAX_CHARS} characters`)
  expect(() =>
    postNotice(
      { audience: 'operator', title: 'safe', body: 'z'.repeat(BOARD_BODY_MAX_CHARS + 1) },
      {},
      clock + 2,
    ),
  ).toThrow(`${BOARD_BODY_MAX_CHARS} characters`)
})

test('ack deadline cannot exceed expiry and expired notices do not escalate', () => {
  const clock = Date.now() + 70_000
  expect(() =>
    postNotice(
      {
        audience: 'operator',
        title: 'Impossible deadline',
        body: 'Deadline follows expiry.',
        ackRequired: true,
        deadlineMs: 2_000,
        expiresMs: 1_000,
      },
      {},
      clock,
    ),
  ).toThrow(/deadline 2000ms is later than expiry 1000ms/)
  const posted = postNotice(
    {
      audience: 'operator',
      title: 'Expires before inspection',
      body: 'Do not escalate after expiry.',
      ackRequired: true,
      deadlineMs: 500,
      expiresMs: 1_000,
    },
    {},
    clock + 1,
  )
  expect(
    boardEscalations(clock + 1_002).some((row) => row.subject.startsWith(`board:${posted.id}:`)),
  ).toBeFalse()
})

test('status is limited to operator, author, or an addressed architect and refuses workers', () => {
  const clock = Date.now() + 80_000
  const posting = postingProject()
  const insert = db().query(
    `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,last_seen)
     VALUES (?,'claude-code','architect','test','status-project','/tmp',NULL,?)`,
  )
  for (const session of ['status-author', 'status-reader', 'status-stranger'])
    insert.run(session, new Date(clock).toISOString())
  const posted = postNotice(
    { audience: 'session:status-reader', title: 'Guarded status', body: 'Only relevant actors.' },
    { CLAUDE_CODE_SESSION_ID: 'status-author' },
    clock,
    posting.cwd,
  )
  expect(noticeStatus(posted.id, {}).message.id).toBe(posted.id)
  expect(noticeStatus(posted.id, { CLAUDE_CODE_SESSION_ID: 'status-author' }).message.id).toBe(
    posted.id,
  )
  expect(
    noticeStatus(posted.id, { CLAUDE_CODE_SESSION_ID: 'status-reader' }, clock + 1).message.id,
  ).toBe(posted.id)
  expect(() =>
    noticeStatus(posted.id, { CLAUDE_CODE_SESSION_ID: 'status-stranger' }, clock + 1),
  ).toThrow(/not authored by or addressed/)
  expect(() => noticeStatus(posted.id, { ORCH_RUN_ID: '123' })).toThrow(/workers cannot/)
})

test('reserved operator sentinel is refused on every session-aware board path', () => {
  const env = { CLAUDE_CODE_SESSION_ID: 'operator' }
  const posted = postNotice(
    { audience: 'operator', title: 'Sentinel target', body: 'Used to exercise guards.' },
    {},
    Date.now() + 90_000,
  )
  expect(() => recordPresence('/tmp', env)).toThrow(/reserved/)
  expect(() => postNotice({ audience: 'operator', title: 'x', body: 'y' }, env)).toThrow(/reserved/)
  expect(() => readNotices(false, env)).toThrow(/reserved/)
  expect(() => acknowledgeNotice(posted.id, env)).toThrow(/reserved/)
  expect(() => noticeStatus(posted.id, env)).toThrow(/reserved/)
})

test('delivery entry point refuses the operator sentinel before changing its receipt', () => {
  const clock = Date.now() + 95_000
  const posted = postNotice(
    { audience: 'operator', title: 'Operator receipt', body: 'Must remain untouched.' },
    {},
    clock,
  )
  expect(() => markInterruptNoticesDelivered('operator', [posted.id])).toThrow(/real session id/)
  expect(() => markMonitorNoticesDelivered('operator', [`board:${posted.id}`])).toThrow(
    /real session id/,
  )
  expect(
    db()
      .query('SELECT delivered_at FROM board_receipt WHERE message_id=? AND reader_session=?')
      .get(posted.id, 'operator'),
  ).toEqual({ delivered_at: null })
})

test('machine:this resolves to the posting machine, interrupts, and reports unacknowledged sessions', () => {
  const clock = Date.now() + 100_000
  const machine = hostname()
  const insert = db().query(
    `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,last_seen)
     VALUES (?,'claude-code','architect',?,?,'/tmp',NULL,?)`,
  )
  insert.run('machine-one', machine, PLATFORM_SLUG, new Date(clock).toISOString())
  insert.run('machine-two', machine, PLATFORM_SLUG, new Date(clock).toISOString())
  insert.run('elsewhere', `${machine}-elsewhere`, PLATFORM_SLUG, new Date(clock).toISOString())
  const posted = postNotice(
    {
      audience: 'machine:this',
      title: 'Machine wind-down',
      body: 'Checkpoint before restart.',
      ackRequired: true,
    },
    {},
    clock,
  )
  expect(
    (
      db().query('SELECT audience FROM board_message WHERE id=?').get(posted.id) as {
        audience: string
      }
    ).audience,
  ).toBe(`machine:${machine}`)
  expect(claimInterruptNotices('machine-one', clock + 1).map((notice) => notice.noticeId)).toEqual([
    `board:${posted.id}`,
  ])
  expect(noticeStatus(posted.id, {}, clock + 1).unacknowledged).toEqual([
    'machine-one',
    'machine-two',
  ])
  acknowledgeNotice(posted.id, { CLAUDE_CODE_SESSION_ID: 'machine-one' }, clock + 2)
  expect(noticeStatus(posted.id, {}, clock + 2).unacknowledged).toEqual(['machine-two'])
})

test('ack escalation keeps the posting-time audience snapshot across presence refreshes', () => {
  const clock = Date.now() + 10_000
  const insertPresence = db().query(
    `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,last_seen)
     VALUES (?,'claude-code','architect','test','snapshot-project','/tmp',NULL,?)
     ON CONFLICT(session_id) DO UPDATE SET project=excluded.project,last_seen=excluded.last_seen`,
  )
  insertPresence.run('posting-reader', new Date(clock).toISOString())
  const posted = postNotice(
    {
      audience: 'project:snapshot-project',
      title: 'Snapshot audience',
      body: 'Acknowledge this.',
      ackRequired: true,
      deadlineMs: 1_000,
    },
    {},
    clock,
  )
  insertPresence.run('posting-reader', new Date(clock + 500).toISOString())
  insertPresence.run('late-reader', new Date(clock + 500).toISOString())
  readNotices(false, { CLAUDE_CODE_SESSION_ID: 'late-reader' }, clock + 500)
  expect(
    boardEscalations(clock + 1_001)
      .filter((row) => row.subject.startsWith(`board:${posted.id}:`))
      .map((row) => row.subject),
  ).toEqual([`board:${posted.id}:posting-reader`])
})
