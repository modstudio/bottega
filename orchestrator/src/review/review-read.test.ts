import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { applyMigrations } from '../database/migrations.ts'
import { recordArchitectRead, requireBranchRunOwner } from './review-read.ts'

let priorDepth: string | undefined
let priorSession: string | undefined
beforeEach(() => {
  priorDepth = process.env.ORCH_DEPTH
  priorSession = process.env.CLAUDE_CODE_SESSION_ID
  process.env.ORCH_DEPTH = '1'
})
afterEach(() => {
  if (priorDepth === undefined) delete process.env.ORCH_DEPTH
  else process.env.ORCH_DEPTH = priorDepth
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
  d.query(
    `INSERT INTO run
      (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,repo,branch,session_id)
     VALUES ('2026-09-27','codex','implementation','sha',1,'head','running','fixture','DEV-977-work','owner-session')`,
  ).run()
  expect(requireBranchRunOwner(d, 'fixture', 'DEV-977-work', 'owner-session')).toBe('owner-session')
  expect(() => requireBranchRunOwner(d, 'fixture', 'DEV-977-work', 'foreign-session')).toThrow(
    'calling session does not own DEV-977-work',
  )
})

test('a tip unreachable from the checked-out branch is refused without a review read', () => {
  delete process.env.ORCH_DEPTH
  process.env.CLAUDE_CODE_SESSION_ID = 'owner-session'
  const d = new Database(':memory:')
  applyMigrations(d)
  const cwd = resolve(import.meta.dir, '../../..')
  d.query('INSERT INTO project (name,path,settings) VALUES (?,?,?)').run('fixture', cwd, '{}')
  d.query(
    `INSERT INTO run
      (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,repo,branch,session_id)
     VALUES ('2026-10-02','codex','implementation','sha',1,'head','running','fixture','DEV-1068-work','owner-session')`,
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
    'could not reconcile branch DEV-1068-work with tip unreachable-tip; run orch review read from the worktree that has the branch containing that commit checked out (orch tree open <run> opens one)',
  )
  expect(
    d.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM review_read').get()?.count,
  ).toBe(0)
})
