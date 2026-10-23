import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { applyMigrations } from '../database/migrations.ts'
import { upsertProject } from '../project/projects.ts'
import {
  latestArchitectRead,
  recordArchitectRead,
  recordArchitectReadCommand,
  requireBranchRunOwner,
} from './review-read.ts'

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

let priorDepth: string | undefined
let priorSession: string | undefined
beforeEach(() => {
  priorDepth = process.env.BOTTEGA_DEPTH
  priorSession = process.env.CLAUDE_CODE_SESSION_ID
  process.env.BOTTEGA_DEPTH = '1'
})
afterEach(() => {
  if (priorDepth === undefined) delete process.env.BOTTEGA_DEPTH
  else process.env.BOTTEGA_DEPTH = priorDepth
  if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = priorSession
})

test('worker sessions cannot record an architect read', () => {
  expect(() => recordArchitectRead({ cwd: '/unused', note: 'read the final fix' })).toThrow(
    'reserved for architect sessions',
  )
})

test('only the root run session owns architect reads for its branch', () => {
  const d = new Database(':memory:')
  applyMigrations(d)
  const projectId = newRecordId()
  d.query(
    "INSERT INTO project (record_id,name,path,settings) VALUES (?,'fixture','/fixture','{}')",
  ).run(projectId)
  d.query(
    `INSERT INTO run
      (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,repo,project_record_id,branch,session_id)
     VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-09-27','codex','implementation','sha',1,'head','running','fixture',?,'DEV-977-work','owner-session')`,
  ).run(projectId)
  expect(requireBranchRunOwner(d, 'fixture', 'DEV-977-work', 'owner-session')).toBe('owner-session')
  expect(() => requireBranchRunOwner(d, 'fixture', 'DEV-977-work', 'foreign-session')).toThrow(
    'calling session does not own DEV-977-work',
  )
})

test('the latest architect read is selected for one project branch', () => {
  const d = new Database(':memory:')
  applyMigrations(d)
  const projectRecordId = newRecordId()
  d.query(
    `INSERT INTO project (record_id,name,path,canon,settings) VALUES (?,'fixture','/fixture',1,'{}')`,
  ).run(projectRecordId)
  d.query(
    `INSERT INTO review_read
      (record_id,project,project_record_id,branch,tip,patch_id,path_set,tier,note,recorded_at)
     VALUES
      ('read-1','fixture',?,'DEV-1257-work','older','patch-1','[]',1,'older note','2026-10-11T12:00:00.000Z'),
      ('read-2','fixture',?,'DEV-1257-work','newer','patch-2','[]',1,'newer note','2026-10-12T12:00:00.000Z'),
      ('read-3','fixture',?,'DEV-other','other','patch-3','[]',1,'other note','2026-10-13T12:00:00.000Z')`,
  ).run(projectRecordId, projectRecordId, projectRecordId)

  expect(latestArchitectRead(d, 'fixture', 'DEV-1257-work')).toEqual({
    tip: 'newer',
    note: 'newer note',
    recordedAt: '2026-10-12T12:00:00.000Z',
  })
  expect(latestArchitectRead(d, 'fixture', 'missing')).toBeNull()
})

test('the read command records the branch and tip from --cwd', () => {
  delete process.env.BOTTEGA_DEPTH
  process.env.CLAUDE_CODE_SESSION_ID = 'owner-session'
  const cwd = mkdtempSync(join(tmpdir(), 'orch-review-read-'))
  try {
    git(cwd, 'init', '-b', 'main')
    writeFileSync(join(cwd, 'base.txt'), 'base\n')
    git(cwd, 'add', 'base.txt')
    git(
      cwd,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      'commit',
      '-m',
      'base',
    )
    git(cwd, 'switch', '-c', 'DEV-1262-review-read-fixture')
    writeFileSync(join(cwd, 'change.txt'), 'change\n')
    git(cwd, 'add', 'change.txt')
    git(
      cwd,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      'commit',
      '-m',
      'change',
    )
    const tip = git(cwd, 'rev-parse', 'HEAD')
    expect(git(process.cwd(), 'branch', '--show-current')).not.toBe('DEV-1262-review-read-fixture')
    upsertProject({
      recordId: newRecordId(),
      name: 'read-command-fixture',
      path: cwd,
      settings: { trunk: 'main' },
    })
    db()
      .query(
        `INSERT INTO run
          (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,repo,project_record_id,branch,session_id)
         VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-10-12','codex','implementation','sha',1,'head','running',?,
                 (SELECT record_id FROM project WHERE name=?),?,?)`,
      )
      .run(
        'read-command-fixture',
        'read-command-fixture',
        'DEV-1262-review-read-fixture',
        'owner-session',
      )

    const relativeCwd = relative(process.cwd(), cwd)
    recordArchitectReadCommand(
      ['review', 'read'],
      {
        flag: (name) =>
          name === 'cwd' ? relativeCwd : name === 'note' ? 'read the final fix' : undefined,
      },
      { log: () => undefined },
    )

    expect(
      db()
        .query<{ branch: string; tip: string }, []>(
          'SELECT branch,tip FROM review_read ORDER BY recorded_at,record_id DESC LIMIT 1',
        )
        .get(),
    ).toEqual({ branch: 'DEV-1262-review-read-fixture', tip })

    const missing = join(cwd, 'does-not-exist')
    expect(() =>
      recordArchitectReadCommand(
        ['review', 'read'],
        {
          flag: (name) =>
            name === 'cwd' ? missing : name === 'note' ? 'read the final fix' : undefined,
        },
        { log: () => undefined },
      ),
    ).toThrow(
      `${missing} does not exist; pass a live worktree (${PLATFORM_SLUG} tree open <run> opens one)`,
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('a tip unreachable from the checked-out branch is refused without a review read', () => {
  delete process.env.BOTTEGA_DEPTH
  process.env.CLAUDE_CODE_SESSION_ID = 'owner-session'
  const d = new Database(':memory:')
  applyMigrations(d)
  const cwd = resolve(import.meta.dir, '../../..')
  d.query(
    'INSERT INTO project (record_id,name,path,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?)',
  ).run('fixture', cwd, '{}')
  d.query(
    `INSERT INTO run
      (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,repo,project_record_id,branch,session_id)
     VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-10-02','codex','implementation','sha',1,'head','running','fixture',
             (SELECT record_id FROM project WHERE name='fixture'),'DEV-1068-work','owner-session')`,
  ).run()
  const runGit = (_cwd: string, args: string[]): string => {
    if (args[0] === 'branch') return 'DEV-1068-work'
    if (args[0] === 'rev-parse') return 'unreachable-tip'
    if (args[0] === 'merge-base') throw new Error('not an ancestor')
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  }

  expect(() =>
    recordArchitectRead({ cwd, sha: 'unreachable', note: 'read the final fix' }, d, runGit),
  ).toThrow(
    `could not reconcile branch DEV-1068-work with tip unreachable-tip; run ${PLATFORM_SLUG} review read from the worktree that has the branch containing that commit checked out (${PLATFORM_SLUG} tree open <run> opens one)`,
  )
  expect(
    d.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM review_read').get()?.count,
  ).toBe(0)
})
