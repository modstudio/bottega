import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { Command } from 'commander'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { registerBoardCommands } from './board-commands.ts'
import { BOARD_REACH_MAX_HOURS } from './board-reach.ts'
import { postNotice } from './board-service.ts'
import { suggestBoardPost } from './board-suggestions.ts'

test('board presence validates and records the hook start instant', async () => {
  const cwd = process.cwd()
  db()
    .query(
      `INSERT OR IGNORE INTO project(record_id,name,path,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'board-presence-cli',?,'{}')`,
    )
    .run(cwd)
  const previous = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = 'presence-cli-reader'
  try {
    const invalid = new Command().exitOverride()
    registerBoardCommands(invalid)
    await expect(
      invalid.parseAsync(['node', 'orch', 'board', 'presence', '--started-at', 'yesterday']),
    ).rejects.toThrow(/ISO 8601 UTC instant/)

    const startedAt = '2026-10-13T12:00:00.000Z'
    const program = new Command().exitOverride()
    registerBoardCommands(program)
    await program.parseAsync(['node', 'orch', 'board', 'presence', '--started-at', startedAt])
    expect(
      db().query('SELECT first_seen FROM presence WHERE session_id=?').get('presence-cli-reader'),
    ).toEqual({ first_seen: startedAt })
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = previous
  }
})

test('board status CLI refuses worker callers', async () => {
  const posted = postNotice(
    { audience: 'operator', title: 'CLI status guard', body: 'Workers cannot inspect status.' },
    {},
  )
  const program = new Command().exitOverride()
  registerBoardCommands(program)
  process.env.ORCH_RUN_ID = 'cli-board-worker'
  try {
    await expect(
      program.parseAsync(['node', 'orch', 'board', 'status', String(posted.id)]),
    ).rejects.toThrow(/workers cannot use the architect notice board/)
  } finally {
    delete process.env.ORCH_RUN_ID
  }
})

test('board reach refuses windows beyond retained history with a remedy', async () => {
  const program = new Command().exitOverride()
  registerBoardCommands(program)
  await expect(
    program.parseAsync([
      'node',
      'orch',
      'board',
      'reach',
      '--hours',
      String(BOARD_REACH_MAX_HOURS + 1),
    ]),
  ).rejects.toThrow(/cannot exceed .*export reports regularly/)
})

test('suggestion post CLI collects path overrides and preserves omitted suggestion tags', async () => {
  const cwd = resolve(import.meta.dir, '../../..')
  db()
    .query(
      `INSERT OR IGNORE INTO project(record_id,name,path,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'board-cli-project',?,'{}')`,
    )
    .run(cwd)
  const createRun = db().query(
    `INSERT INTO run
     (record_id,started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,session_id)
     VALUES (?,'2026-10-05','codex','implement','board-cli-project','sha',1,'prompt','running','cli-owner')
     RETURNING id`,
  )
  const envBefore = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = 'cli-owner'
  try {
    const overriddenRun = createRun.get(newRecordId()) as { id: number }
    const overridden = suggestBoardPost(overriddenRun.id, {
      title: 'Override path',
      body: 'Use the command path.',
      paths: ['original/**'],
    })
    const overrideProgram = new Command().exitOverride()
    registerBoardCommands(overrideProgram)
    await overrideProgram.parseAsync([
      'node',
      'orch',
      'board',
      'suggestion',
      'post',
      String(overridden.id),
      '--audience',
      'operator',
      '--path',
      'override/**',
    ])
    expect(
      db()
        .query(
          `SELECT value FROM board_message_tag
           WHERE message_id=(SELECT id FROM board_message WHERE kind='notice' AND author_run_id=?)
             AND kind='path' AND origin='sender'`,
        )
        .all(overriddenRun.id),
    ).toEqual([{ value: 'override/**' }])

    const inheritedRun = createRun.get(newRecordId()) as { id: number }
    const inherited = suggestBoardPost(inheritedRun.id, {
      title: 'Keep path',
      body: 'Use the suggestion path.',
      paths: ['inherited/**'],
    })
    const inheritedProgram = new Command().exitOverride()
    registerBoardCommands(inheritedProgram)
    await inheritedProgram.parseAsync([
      'node',
      'orch',
      'board',
      'suggestion',
      'post',
      String(inherited.id),
      '--audience',
      'operator',
    ])
    expect(
      db()
        .query(
          `SELECT value FROM board_message_tag
           WHERE message_id=(SELECT id FROM board_message WHERE kind='notice' AND author_run_id=?)
             AND kind='path' AND origin='sender'`,
        )
        .all(inheritedRun.id),
    ).toEqual([{ value: 'inherited/**' }])
  } finally {
    if (envBefore === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = envBefore
  }
})
