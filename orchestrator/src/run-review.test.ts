import { afterEach,describe,expect,test } from 'bun:test'
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedTransport } from '../test/fake-transport.ts'
import { cloneRepository, hermeticGitEnv } from '../test/fixtures/git.ts'
import { reviewReply } from '../test/fixtures/replies.ts'
import { addRun } from '../test/fixtures/store.ts'
import { db } from './db.ts'
import { run as runJob } from './run.ts'
import { installTestTransport } from './transport.ts'

afterEach(() => installTestTransport(null))
describe('review-lens-inline has no checkout', () => {
  test('summarize runs under srt from an unregistered directory', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'orch-unregistered-summary-'))
    const oldSandbox = process.env.ORCH_SANDBOX; const oldDepth = process.env.ORCH_DEPTH
    try {
      scriptedTransport([{ kind: 'completed', output: 'summary from anywhere' }]).install()
      delete process.env.ORCH_SANDBOX; process.env.ORCH_DEPTH = '0'
      const result = await runJob({ job: 'summarize', prompt: 'summarize inline context', cwd, agent: 'grok', noFailover: true })
      expect(result.output).toBe('summary from anywhere')
      expect(db().query('SELECT sandbox FROM run WHERE id=?').get(result.id)).toEqual({ sandbox: 'srt' })
    } finally {
      if (oldSandbox === undefined) delete process.env.ORCH_SANDBOX; else process.env.ORCH_SANDBOX = oldSandbox
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH; else process.env.ORCH_DEPTH = oldDepth
      rmSync(cwd, { recursive: true, force: true })
    }
  })
  test('a resumed findings turn records its review against the root run', async () => {
    const priorDepth = process.env.ORCH_DEPTH
    const promptPath = join(tmpdir(), `resumed-review-${crypto.randomUUID()}.prompt.txt`)
    const root = addRun({ agent: 'codex', job: 'review-lens-inline', status: 'asking', session: 'orch-test-session', lens: 'resumed-review' })
    writeFileSync(promptPath, 'original review prompt')
    db().query('UPDATE run SET prompt_path=?, vendor_session=? WHERE id=?').run(promptPath, 'review-vendor-session', root)
    try {
      scriptedTransport([{ kind: 'completed', output: JSON.stringify(reviewReply(1)) }]).install(); process.env.ORCH_DEPTH = '0'
      const resumed = await runJob({ job: 'review-lens-inline', prompt: 'continue', agent: 'codex', lens: 'resumed-review',
        resume: { parent: root, agent: 'codex', session: 'review-vendor-session', turn: 2, sessionId: 'orch-test-session', worktree: null } })
      expect(resumed.status).toBe('ok')
      expect(db().query('SELECT status FROM run WHERE id=?').get(root)).toEqual({ status: 'ok' })
      expect(db().query('SELECT review_id FROM review_lens WHERE run_id=?').get(root)).not.toBeNull()
      expect(db().query('SELECT review_id FROM review_lens WHERE run_id=?').get(resumed.id)).toBeNull()
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH; else process.env.ORCH_DEPTH = priorDepth
      rmSync(promptPath, { force: true })
    }
  })
  test('run 1715 shape completes as unevidenced and result wraps it as incomplete', async () => {
    const priorDepth = process.env.ORCH_DEPTH; const reply = reviewReply(0) as any
    reply.provenance.standards_read = []; reply.provenance.files_covered = []; reply.provenance.commands_run = []
    reply.provenance.could_not_verify = ['Full operator prompt not yet read']; let runId: number | undefined
    try {
      scriptedTransport([{ kind: 'completed', output: JSON.stringify(reply) }]).install(); process.env.ORCH_DEPTH = '0'
      try { await runJob({ job: 'review-lens-inline', prompt: 'inspect this pack', agent: 'codex', lens: 'empty', noFailover: true }) }
      catch (cause) { runId = (cause as Error & { runId?: number }).runId }
      expect(runId).toBeNumber()
      expect(db().query('SELECT status, failure_kind, error FROM run WHERE id=?').get(runId!)).toEqual({
        status: 'failed', failure_kind: 'unevidenced',
        error: expect.stringContaining('clean review with no evidence: files_covered and commands_run are empty'),
      })
      expect(db().query('SELECT id FROM score WHERE run_id=?').get(runId!)).toBeNull()
      expect(db().query('SELECT id FROM review_lens WHERE run_id=?').get(runId!)).toBeNull()
    } finally { if (priorDepth === undefined) delete process.env.ORCH_DEPTH; else process.env.ORCH_DEPTH = priorDepth }
  })
  test('an unregistered implicit review fails as harness naming the project', async () => {
    const repo = cloneRepository('orch-unregistered-review-'); const oldDepth = process.env.ORCH_DEPTH
    const git = (...args: string[]) => { const p = Bun.spawnSync(['git', ...args], { cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' }); if (p.exitCode !== 0) throw new Error(p.stderr.toString()) }
    try {
      git('branch', '-m', 'develop')
      writeFileSync(join(repo, 'changed.txt'), 'change\n'); git('add', '.'); git('commit', '-m', 'fixture')
      const reply = reviewReply(0); reply.provenance.files_covered = ['changed.txt']
      scriptedTransport([{ kind: 'completed', output: JSON.stringify(reply) }]).install(); process.env.ORCH_DEPTH = '0'
      let runId: number | undefined
      try { await runJob({ job: 'review-lens', prompt: 'inspect', cwd: repo, agent: 'codex', lens: 'unregistered-evidence', repo: 'ghost-unregistered-project', noFailover: true }) }
      catch (cause) { runId = (cause as Error & { runId?: number }).runId }
      expect(runId).toBeNumber()
      expect(db().query('SELECT status, failure_kind, error FROM run WHERE id=?').get(runId!)).toEqual({ status: 'failed', failure_kind: 'harness', error: expect.stringContaining('project ghost-unregistered-project is not registered') })
      expect(db().query('SELECT id FROM review_lens WHERE run_id=?').get(runId!)).toBeNull()
    } finally {
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH; else process.env.ORCH_DEPTH = oldDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
