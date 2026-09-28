import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import { recordArchitectRead, requireBranchRunOwner } from './review-read.ts'

let priorDepth: string | undefined
beforeEach(() => {
  priorDepth = process.env.ORCH_DEPTH
  process.env.ORCH_DEPTH = '1'
})
afterEach(() => {
  if (priorDepth === undefined) delete process.env.ORCH_DEPTH
  else process.env.ORCH_DEPTH = priorDepth
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
