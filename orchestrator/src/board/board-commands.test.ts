import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { Command } from 'commander'
import { db } from '../database/db.ts'
import { registerBoardCommands } from './board-commands.ts'
import { postNotice } from './board-service.ts'
import { suggestBoardPost } from './board-suggestions.ts'

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

test('suggestion post CLI collects path overrides and preserves omitted suggestion tags', async () => {
  const cwd = resolve(import.meta.dir, '../../..')
  db()
    .query(`INSERT OR IGNORE INTO project(name,path,settings) VALUES ('board-cli-project',?,'{}')`)
    .run(cwd)
  const createRun = db().query(
    `INSERT INTO run
     (started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,session_id)
     VALUES ('2026-10-05','codex','implement','board-cli-project','sha',1,'prompt','running','cli-owner')
     RETURNING id`,
  )
  const envBefore = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = 'cli-owner'
  try {
    const overriddenRun = createRun.get() as { id: number }
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

    const inheritedRun = createRun.get() as { id: number }
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
