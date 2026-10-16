import { expect, test } from 'bun:test'
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import {
  BOARD_INFORMATION_DEFAULT_EXPIRY_MS,
  BOARD_REQUEST_DEFAULT_EXPIRY_MS,
  BOARD_STANDING_DEFAULT_EXPIRY_MS,
} from '../../../shared/board-duration.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { markMonitorNoticesDelivered } from '../monitor/monitor-notices.ts'
import { projectAt } from '../project/projects.ts'
import { BOARD_BODY_MAX_CHARS, BOARD_TITLE_MAX_CHARS } from './board-policy.ts'
import {
  acknowledgeNotice,
  boardEscalations,
  claimNotices,
  claimPushNotices,
  claimRunNotices,
  claimRunPushNotices,
  markSessionMessagesDelivered,
  noticeStatus,
  postNotice,
  readNotices,
  recordPresence,
} from './board-service.ts'
import { askQuestion, replyToThread } from './board-thread-service.ts'

test('local posts default acknowledgement-required messages to request', () => {
  const posted = postNotice({
    audience: 'operator',
    title: 'Compatibility request',
    body: 'A previous sender omitted purpose.',
    ackRequired: true,
  })
  expect(
    db().query('SELECT purpose,ack_required FROM board_message WHERE id=?').get(posted.id),
  ).toEqual({ purpose: 'request', ack_required: 1 })
  expect(() =>
    postNotice({
      audience: 'operator',
      title: 'Explicit information',
      body: 'This combination remains invalid.',
      purpose: 'information',
      ackRequired: true,
    }),
  ).toThrow(/use purpose request or standing/)
})

function postingProject() {
  const cwd = resolve(import.meta.dir, '../../..')
  db()
    .query(
      `INSERT OR IGNORE INTO project(record_id,name,path,settings)
       VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'board-post-fixture',?,'{}')`,
    )
    .run(cwd)
  const project = projectAt(cwd)
  if (!project) throw new Error('board post test project did not resolve')
  return { cwd, project }
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

test('a created message, tag and receipt carry a version-7 record id', () => {
  const clock = Date.now()
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,last_seen)
     VALUES ('board-id-reader','claude-code','architect','test',?,'/tmp',NULL,?)`,
    )
    .run(PLATFORM_SLUG, new Date(clock).toISOString())
  const posted = postNotice(
    {
      audience: 'architects:all',
      title: 'Identity',
      body: 'Minted ids.',
      purpose: 'information',
      task: 'DEV-1214',
    },
    {},
    clock,
  )
  expect(
    db()
      .query<{ record_id: string }, [number]>('SELECT record_id FROM board_message WHERE id=?')
      .get(posted.id)?.record_id,
  ).toMatch(UUID_V7)
  expect(
    db()
      .query<{ record_id: string }, [number]>(
        'SELECT record_id FROM board_message_tag WHERE message_id=?',
      )
      .get(posted.id)?.record_id,
  ).toMatch(UUID_V7)
  expect(
    db()
      .query<{ record_id: string }, [number]>(
        'SELECT record_id FROM board_receipt WHERE message_id=?',
      )
      .get(posted.id)?.record_id,
  ).toMatch(UUID_V7)
})

test('notice store round-trip resolves, renders, delivers, and explicitly acknowledges', () => {
  const clock = Date.now()
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,last_seen)
     VALUES ('board-reader','claude-code','architect','test',?,'/tmp',NULL,?)`,
    )
    .run(PLATFORM_SLUG, new Date(clock).toISOString())
  const posted = postNotice(
    {
      audience: 'architects:all',
      title: 'Wind down',
      body: 'Finish owned work.',
      ackRequired: true,
      purpose: 'request',
    },
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
    db()
      .query('SELECT first_seen,last_seen FROM presence WHERE session_id=?')
      .get(env.CLAUDE_CODE_SESSION_ID),
  ).toEqual({ first_seen: '2026-10-05T11:00:00.000Z', last_seen: '2026-10-05T12:00:00.000Z' })
})

test('local architect audiences select the posting project, all projects, or one named project', () => {
  const { cwd, project } = postingProject()
  const clock = Date.now()
  db()
    .query(
      `INSERT OR IGNORE INTO project(record_id,name,path,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'board-other','/tmp/board-other','{}')`,
    )
    .run()
  const presence = db().query(
    `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
     VALUES (?,'claude-code','architect','test',?,'/tmp',NULL,?,?)`,
  )
  for (const [session, name] of [
    ['architect-a', project.name],
    ['architect-b', 'board-other'],
  ] as const)
    presence.run(session, name, new Date(clock).toISOString(), new Date(clock).toISOString())
  const env = { CLAUDE_CODE_SESSION_ID: 'architect-author' }
  const posting = postNotice(
    { audience: 'architects', title: 'Local project', body: 'A only.' },
    env,
    clock,
    cwd,
  )
  const all = postNotice(
    { audience: 'architects:all', title: 'Local all', body: 'Both.' },
    env,
    clock + 1,
    cwd,
  )
  const named = postNotice(
    { audience: 'architects:board-other', title: 'Local named', body: 'B only.' },
    env,
    clock + 2,
    cwd,
  )
  expect(
    noticeStatus(posting.id, env, clock + 3).receipts.map((row) => row.reader_session),
  ).toEqual(['architect-a', 'architect-author'])
  expect(noticeStatus(all.id, env, clock + 3).receipts.map((row) => row.reader_session)).toEqual([
    'architect-a',
    'architect-author',
    'architect-b',
  ])
  expect(noticeStatus(named.id, env, clock + 3).receipts.map((row) => row.reader_session)).toEqual([
    'architect-b',
  ])
  expect(() =>
    postNotice(
      { audience: 'architects:missing', title: 'Unknown', body: 'No.' },
      env,
      clock + 4,
      cwd,
    ),
  ).toThrow(new RegExp(`unknown board project missing.*${PLATFORM_SLUG} project list`))
  expect(() =>
    postNotice(
      { audience: 'architects', title: 'Projectless', body: 'No.' },
      env,
      clock + 5,
      '/tmp/outside-registered-projects',
    ),
  ).toThrow(/use architects:all or architects:<project>/)
})

test('a message posted after the hook start but before presence is written is due', () => {
  const { cwd } = postingProject()
  const start = Date.parse('2026-10-05T11:00:00.000Z')
  const env = { CLAUDE_CODE_SESSION_ID: 'presence-race-reader' }
  const posted = postNotice(
    { audience: 'session:presence-race-reader', title: 'During start', body: 'Still due.' },
    {},
    start + 1,
  )
  recordPresence(cwd, env, new Date(start).toISOString())
  expect(claimPushNotices(false, env, start + 2).notices.map((notice) => notice.id)).toEqual([
    posted.id,
  ])
})

test('operator push is unbounded and a missing session start withholds required acknowledgement', () => {
  const { cwd, project } = postingProject()
  const clock = Date.parse('2026-10-05T11:30:00.000Z')
  const operatorNotice = postNotice(
    { audience: 'operator', title: 'Operator history', body: 'Operator sees this.' },
    {},
    clock,
  )
  expect(claimPushNotices(false, {}, clock + 10_000)).toMatchObject({
    notices: [{ id: operatorNotice.id }],
    withheldOlderCount: 0,
    warning: null,
  })

  const insertPresence = db().query(
    `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
     VALUES (?,'claude-code','architect','test',?,?,NULL,?,?)`,
  )
  insertPresence.run(
    'missing-start-reader',
    project.name,
    cwd,
    new Date(clock).toISOString(),
    new Date(clock).toISOString(),
  )
  insertPresence.run(
    'thread-author',
    project.name,
    cwd,
    new Date(clock).toISOString(),
    new Date(clock).toISOString(),
  )
  const question = askQuestion(
    { audience: 'session:missing-start-reader', title: 'Thread', body: 'Join this thread.' },
    { CLAUDE_CODE_SESSION_ID: 'thread-author' },
    clock + 1,
    cwd,
  )
  replyToThread(
    question.id,
    'Reader joined.',
    { CLAUDE_CODE_SESSION_ID: 'missing-start-reader' },
    clock + 2,
    cwd,
  )
  const reply = replyToThread(
    question.id,
    'Author followed up.',
    { CLAUDE_CODE_SESSION_ID: 'thread-author' },
    clock + 3,
    cwd,
  )
  const required = postNotice(
    {
      audience: 'session:missing-start-reader',
      title: 'Acknowledge this',
      body: 'Only a reader known to be running at posting may receive this.',
      ackRequired: true,
    },
    {},
    clock + 3,
  )
  db().query('DELETE FROM presence WHERE session_id=?').run('missing-start-reader')
  const missing = claimPushNotices(
    false,
    { CLAUDE_CODE_SESSION_ID: 'missing-start-reader' },
    clock + 4,
  )
  expect(missing.notices.map((notice) => notice.id)).toContain(reply.id)
  expect(missing.notices.map((notice) => notice.id)).not.toContain(required.id)
  expect(missing.warning).toContain('has no recorded start')
})

test('tagged project notices are not pushed to a late session even when acknowledgement is required', () => {
  const clock = Date.now() + 10_000
  const project = 'board-routing-project'
  const insertPresence = db().query(
    `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,last_seen)
     VALUES (?,'claude-code','architect','test',?,'/tmp',NULL,?)`,
  )
  const insertRun = db().query(
    `INSERT INTO run
     (record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,session_id,changed_paths)
     VALUES (?,?,'codex','implement','sha',1,'prompt','ok',?,?)`,
  )
  for (const [session, paths] of [
    ['matching-reader', ['orchestrator/src/board/board-service.ts']],
    ['other-reader', ['hub/web/src/routes/index.tsx']],
  ] as const) {
    insertPresence.run(session, project, new Date(clock).toISOString())
    insertRun.run(newRecordId(), new Date(clock).toISOString(), session, JSON.stringify(paths))
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

  const required = postNotice(
    {
      audience: `project:${project}`,
      title: 'Required board work',
      body: 'Acknowledge the board service change.',
      paths: ['orchestrator/src/board/**'],
      ackRequired: true,
      purpose: 'request',
    },
    {},
    clock + 1,
  )
  const standing = postNotice(
    {
      audience: `project:${project}`,
      title: 'Standing board work',
      body: 'This remains true.',
      paths: ['orchestrator/src/board/**'],
      purpose: 'standing',
    },
    {},
    clock + 1,
  )

  insertPresence.run('late-reader', project, new Date(clock + 2).toISOString())
  insertRun.run(
    newRecordId(),
    new Date(clock + 2).toISOString(),
    'late-reader',
    JSON.stringify(['orchestrator/src/board/board-routing.ts']),
  )
  expect(
    claimPushNotices(false, { CLAUDE_CODE_SESSION_ID: 'late-reader' }, clock + 3),
  ).toMatchObject({
    notices: [{ id: standing.id }],
    withheldOlderCount: 2,
  })
  expect(
    readNotices(false, { CLAUDE_CODE_SESSION_ID: 'late-reader' }, clock + 4).map(
      (notice) => notice.id,
    ),
  ).toEqual([posted.id, required.id, standing.id])
  expect(noticeStatus(posted.id, {}).reached).toBe(2)
})

test('purpose chooses the default expiry and an explicit expiry wins', () => {
  const clock = Date.parse('2026-10-13T12:00:00.000Z')
  const cases = [
    ['information', BOARD_INFORMATION_DEFAULT_EXPIRY_MS],
    ['request', BOARD_REQUEST_DEFAULT_EXPIRY_MS],
    ['standing', BOARD_STANDING_DEFAULT_EXPIRY_MS],
  ] as const
  for (const [purpose, lifetime] of cases) {
    const posted = postNotice(
      { audience: 'operator', title: `Default ${purpose}`, body: 'Body', purpose },
      {},
      clock,
    )
    expect(Date.parse(noticeStatus(posted.id, {}, clock).row.expires_at!)).toBe(clock + lifetime)
  }
  const explicit = postNotice(
    {
      audience: 'operator',
      title: 'Explicit standing',
      body: 'Body',
      purpose: 'standing',
      expiresMs: 123_456,
    },
    {},
    clock,
  )
  expect(Date.parse(noticeStatus(explicit.id, {}, clock).row.expires_at!)).toBe(clock + 123_456)
})

test('tagged project notice reaches a matching worker chain and withholds from another', () => {
  const clock = Date.now() + 12_000
  const insertRun = db().query(
    `INSERT INTO run
     (record_id,started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,launch_key,changed_paths,parent_run_id,turn)
     VALUES (?,?,'codex','implement','worker-board-project','sha',1,'prompt',?,?,?,?,?) RETURNING id`,
  )
  const matching = insertRun.get(
    newRecordId(),
    new Date(clock).toISOString(),
    'running',
    'DEV-MATCH',
    JSON.stringify(['orchestrator/src/board/board-service.ts']),
    null,
    1,
  ) as { id: number }
  const other = insertRun.get(
    newRecordId(),
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

test('a run reader is pushed only notices posted after its start', () => {
  const clock = Date.now() + 12_500
  const run = db()
    .query(
      `INSERT INTO run
       (record_id,started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,launch_key,turn)
       VALUES ('${newRecordId()}',?,'codex','implement','worker-board-project','sha',1,'prompt','running','DEV-PUSH',1)
       RETURNING id`,
    )
    .get(new Date(clock).toISOString()) as { id: number }
  const older = postNotice(
    { audience: `run:${run.id}`, title: 'Older', body: 'Do not push this.' },
    {},
    clock - 2,
  )
  const required = postNotice(
    {
      audience: `run:${run.id}`,
      title: 'Older required',
      body: 'Push this for acknowledgement.',
      ackRequired: true,
      purpose: 'request',
    },
    {},
    clock - 1,
  )
  const newer = postNotice(
    { audience: `run:${run.id}`, title: 'Newer', body: 'Push this.' },
    {},
    clock + 1,
  )

  expect(claimRunPushNotices(run.id, false, clock + 2)).toMatchObject({
    notices: [{ id: newer.id }],
    withheldOlderCount: 2,
  })
  expect(claimRunNotices(run.id, false, clock + 2).map((notice) => notice.id)).toEqual([
    older.id,
    required.id,
    newer.id,
  ])
})

test('a missing run reader returns an unbounded empty selection with a warning', () => {
  expect(claimRunPushNotices(999_999)).toEqual({
    notices: [],
    withheldOlderCount: 0,
    warning: 'Board reader run:999999 has no recorded start; no messages were withheld by age.',
  })
})

test('run audience is owner-gated for architects and resolves a turn to its chain root', () => {
  const clock = Date.now() + 13_000
  const posting = postingProject()
  const insertRun = db().query(
    `INSERT INTO run
     (record_id,started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,session_id,parent_run_id,turn)
     VALUES (?,?,'codex','implement','owned-run-project','sha',1,'prompt','running',?,?,?) RETURNING id`,
  )
  const root = insertRun.get(
    newRecordId(),
    new Date(clock).toISOString(),
    'run-owner',
    null,
    1,
  ) as { id: number }
  const turn = insertRun.get(
    newRecordId(),
    new Date(clock + 1).toISOString(),
    'run-owner',
    root.id,
    2,
  ) as {
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
       (record_id,started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,turn)
       VALUES ('${newRecordId()}',?,'codex','implement',NULL,'sha',1,'prompt','asking',1) RETURNING id`,
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
  const request = postNotice(
    {
      ...input,
      paths: ['orchestrator/src/second/**'],
      topics: ['infra', 'gate'],
      purpose: 'request',
    },
    {},
    clock + 3,
  )
  expect(request.id).not.toBe(retargeted.id)
  expect(request.dropped).toBeFalse()
})

test('plain architects duplicate identity includes the posting project', () => {
  const clock = Date.now() + 19_000
  const firstCwd = resolve(import.meta.dir)
  const secondCwd = resolve(import.meta.dir, '../record')
  const project = db().query(
    `INSERT OR IGNORE INTO project(record_id,name,path,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?, '{}') RETURNING id`,
  )
  project.get('board-duplicate-a', firstCwd)
  project.get('board-duplicate-b', secondCwd)
  const input = { audience: 'architects', title: 'Same notice', body: 'Same body.' }
  const env = { CLAUDE_CODE_SESSION_ID: 'duplicate-project-author' }
  const first = postNotice(input, env, clock, firstCwd)
  const second = postNotice(input, env, clock + 1, secondCwd)
  expect(first.dropped).toBeFalse()
  expect(second.dropped).toBeFalse()
  expect(second.id).not.toBe(first.id)
  expect(
    db()
      .query('SELECT author_project FROM board_message WHERE id IN (?,?) ORDER BY id')
      .all(first.id, second.id),
  ).toEqual([{ author_project: 'board-duplicate-a' }, { author_project: 'board-duplicate-b' }])
})

test('a session-start notice reduced to a title or count stays unread until a stamping read', () => {
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
  // The hook does not stamp ids represented only by its title or fallback count.
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
  ).toThrow(new RegExp(`post from a registered project or run ${PLATFORM_SLUG} project add first`))
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
        purpose: 'request',
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
      purpose: 'request',
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
  expect(() => markSessionMessagesDelivered('operator', [posted.id])).toThrow(/real session id/)
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
      purpose: 'request',
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
  expect(
    claimNotices(false, { CLAUDE_CODE_SESSION_ID: 'machine-one' }, clock + 1).map(
      (notice) => notice.id,
    ),
  ).toEqual([posted.id])
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
      purpose: 'request',
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
