import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { reviewReply } from '../../test/fixtures/replies.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { ARGV_PROMPT_BYTES } from '../agent/agents.ts'
import { packResumePrompt } from '../contract/contract.ts'
import { db } from '../database/db.ts'
import { git, gitOk } from '../git/git-environment.ts'
import { upsertProject } from '../project/projects.ts'
import { recordReview } from '../review/review-triage.ts'
import { continuationMessageBinding } from './continuation-message.ts'
import {
  type ChainTurn,
  continuationTurn,
  continueRun,
  harnessHandoff,
  resumeLaunchFromStored,
} from './run-control.ts'
import { packedResumePrompt } from './run-resume-prompt.ts'

const trackResidue = trackedTestResidue()

const limit = () => ARGV_PROMPT_BYTES

test('the harness handoff builder returns the synchronous command fields', () => {
  const id = addRun({ agent: 'harness', job: 'implement', status: 'running' })
  db()
    .query(
      "UPDATE run SET executor='harness',prompt_path='/runs/prompt.txt',cwd='/work/tree' WHERE record_id=?",
    )
    .run(id)
  expect(harnessHandoff(db(), id)).toEqual({
    run: expect.any(Number),
    record_id: id,
    prompt_path: '/runs/bound-prompt.txt',
    working_directory: '/work/tree',
    finish_command: `${PLATFORM_SLUG} run finish ${id}`,
  })
})

function insert(status: string, job = 'file-question'): string {
  return (
    db()
      .query(
        `INSERT INTO run (record_id,number,started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status,
                         repo, project_record_id, cwd, worktree)
     VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),?, 'codex', ?, 'x', 1, 'x', ?,
             'continuation-fixture',(SELECT record_id FROM project WHERE name='continuation-fixture'),?,?)
     RETURNING record_id AS id`,
      )
      .get(new Date().toISOString(), job, status, dir, dir) as { id: string }
  ).id
}

const priorEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  upsertProject({ recordId: newRecordId(), name: 'continuation-fixture', path: dir })
  priorEnv.CLAUDE_CODE_SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID
  priorEnv.BOTTEGA_DEPTH = process.env.BOTTEGA_DEPTH
  priorEnv.BOTTEGA_EXEC_PATH = process.env.BOTTEGA_EXEC_PATH
  process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
  delete process.env.BOTTEGA_DEPTH
  process.env.BOTTEGA_EXEC_PATH = '/usr/bin/true'
})
afterEach(() => {
  if (priorEnv.CLAUDE_CODE_SESSION_ID === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = priorEnv.CLAUDE_CODE_SESSION_ID
  if (priorEnv.BOTTEGA_DEPTH === undefined) delete process.env.BOTTEGA_DEPTH
  else process.env.BOTTEGA_DEPTH = priorEnv.BOTTEGA_DEPTH
  if (priorEnv.BOTTEGA_EXEC_PATH === undefined) delete process.env.BOTTEGA_EXEC_PATH
  else process.env.BOTTEGA_EXEC_PATH = priorEnv.BOTTEGA_EXEC_PATH
})

describe('inherited resume launch', () => {
  const stored = {
    launch_seed: null as string | null,
    launch_key: null as string | null,
    launch_base: null as string | null,
    base_commit: null as string | null,
    no_failover: 0,
    mcp: null as number | null,
    mcp_error: null as string | null,
    lens: null as string | null,
    review_role: null as 'round' | 'supplementary' | null,
  }

  test.each([
    [1, 'verified', 'require'],
    [1, 'mirror: attach failed', 'prefer'],
    [2, null, 'prefer'],
    [0, null, undefined],
    [null, null, undefined],
  ] as const)('maps stored mcp %s with error %s to %s', (mcp, mcpError, expected) => {
    expect(resumeLaunchFromStored({ ...stored, mcp, mcp_error: mcpError })).toEqual({
      seed: undefined,
      key: undefined,
      base: undefined,
      noFailover: false,
      mcp: expected,
      lens: undefined,
      reviewRole: undefined,
    })
  })

  test('maps null key, seed, base and lens to undefined', () => {
    expect(resumeLaunchFromStored(stored)).toEqual({
      seed: undefined,
      key: undefined,
      base: undefined,
      noFailover: false,
      mcp: undefined,
      lens: undefined,
      reviewRole: undefined,
    })
  })

  test('inherits a supplementary review role', () => {
    expect(resumeLaunchFromStored({ ...stored, review_role: 'supplementary' }).reviewRole).toBe(
      'supplementary',
    )
  })

  test('resumes from the recorded base commit after the launch branch is gone', () => {
    expect(
      resumeLaunchFromStored({
        ...stored,
        launch_base: 'DEV-1042-orch-8083',
        base_commit: '956304fe',
      }).base,
    ).toBe('956304fe')
  })

  test('a reader with a clone commit but no launch base resumes without a base', () => {
    expect(resumeLaunchFromStored({ ...stored, base_commit: '956304fe' }).base).toBeUndefined()
  })

  test('falls back to the launch branch for an old row without a base commit', () => {
    expect(resumeLaunchFromStored({ ...stored, launch_base: 'DEV-1042-orch-8083' }).base).toBe(
      'DEV-1042-orch-8083',
    )
  })
})

describe('run continuation', () => {
  const commitArgs = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test']

  function stoppedRebaseRepository(root: string): { repository: string; branch: string } {
    const repository = trackResidue(join(dir, `continue-rebase-${root}`))
    const branch = 'DEV-1691-mid-rebase'
    mkdirSync(repository)
    git(['init', '-b', branch], repository)
    writeFileSync(join(repository, 'tracked.txt'), 'base\n')
    git(['add', 'tracked.txt'], repository)
    git([...commitArgs, 'commit', '-qm', 'base'], repository)
    git(['checkout', '-q', '-b', 'side'], repository)
    writeFileSync(join(repository, 'tracked.txt'), 'side\n')
    git([...commitArgs, 'commit', '-qam', 'side'], repository)
    git(['checkout', '-q', branch], repository)
    writeFileSync(join(repository, 'tracked.txt'), 'branch\n')
    git([...commitArgs, 'commit', '-qam', 'branch'], repository)
    // The shape run 19165 was left in: git stops with the conflict half-applied.
    expect(gitOk(['rebase', 'side'], repository)).toBeNull()
    return { repository, branch }
  }

  test('a continuation resumes from the newest turn that started, numbered past every turn', () => {
    const turn = (id: string, agent: string, n: number): ChainTurn => ({
      record_id: id,
      agent,
      vendor_session: agent === '(pending)' ? null : 'session',
      turn: n,
      cwd: agent === '(pending)' ? null : '/tree',
      worktree: agent === '(pending)' ? null : '/tree',
      branch: agent === '(pending)' ? null : 'branch',
      base_commit: null,
      worktree_source: agent === '(pending)' ? null : 'git',
    })
    const chain = [
      turn('run-10', 'codex', 1),
      turn('run-11', 'codex', 2),
      turn('run-12', '(pending)', 3),
      turn('run-13', '(pending)', 4),
    ]

    const { latest, nextTurn } = continuationTurn('run-10', chain)

    expect(latest).toMatchObject({ record_id: 'run-11', agent: 'codex', worktree: '/tree' })
    expect(nextTurn).toBe(5)
  })

  test('a chain with no started turn cannot be continued', async () => {
    const root = addRun({
      agent: '(pending)',
      job: 'implement',
      status: 'failed',
      session: 'orch-test-session',
      repo: 'continuation-fixture',
    })

    await expect(continueRun(root, undefined, limit)).rejects.toThrow(
      `run ${root} cannot be continued: no turn in its chain ever started`,
    )
  })

  test('a findings root with a recorded review cannot be re-terminalised', async () => {
    const root = addRun({
      agent: 'codex',
      job: 'review-lens',
      status: 'ok',
      lens: 'correctness',
      session: 'orch-test-session',
    })
    const reviewId = recordReview(root, reviewReply(1, 'high'), db())
    const before = db()
      .query(
        `SELECT r.record_id,r.completed_at,rl.record_id lens_id,rl.run_record_id
       FROM review r JOIN review_lens rl ON rl.review_record_id=r.record_id WHERE r.record_id=?`,
      )
      .get(reviewId)
    await expect(continueRun(root, 'review another turn', limit)).rejects.toThrow(
      "invariant: a recorded review is the run's product and is not re-terminalised",
    )
    expect(
      db()
        .query(
          `SELECT r.record_id,r.completed_at,rl.record_id lens_id,rl.run_record_id
       FROM review r JOIN review_lens rl ON rl.review_record_id=r.record_id WHERE r.record_id=?`,
        )
        .get(reviewId),
    ).toEqual(before)
  })

  test('an open question refuses before a continuation message callback is called', async () => {
    const root = insert('asking')
    db()
      .query(
        `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?)`,
      )
      .run(root, new Date().toISOString(), 'Which correction should be applied?')
    let calls = 0

    await expect(
      continueRun(root, 'architect message', limit, () => {
        calls++
        return 'rendered findings'
      }),
    ).rejects.toThrow(
      `run ${root} is waiting on 1 question(s): ${PLATFORM_SLUG} question answer ${root} ...`,
    )
    expect(calls).toBe(0)
  })

  test('continue --file refuses when a just-below-limit body plus the reminder exceeds argv', async () => {
    const root = insert('ok')
    const longSpec = 's'.repeat(600)
    const shortOverhead = Buffer.byteLength(packResumePrompt('file-question', '', 'x'))
    const body = 'A'.repeat(ARGV_PROMPT_BYTES - shortOverhead)
    const spec = trackResidue(join(dir, `continue-long-${root}.prompt.txt`))
    writeFileSync(spec, longSpec)
    db()
      .query('UPDATE run SET vendor_session=?,agent=?,prompt_path=?,session_id=? WHERE record_id=?')
      .run('parent-session', 'codex', spec, 'orch-test-session', root)
    const assembled = Buffer.byteLength(packedResumePrompt('file-question', body, root))
    await expect(continueRun(root, body, limit)).rejects.toThrow(
      `assembled resume prompt is ${assembled} bytes`,
    )
    expect(db().query('SELECT COUNT(*) n FROM run WHERE parent_run_record_id=?').get(root)).toEqual(
      {
        n: 0,
      },
    )
  })

  test('vendor-session continuation does not recover prior instructions', async () => {
    const root = addRun({
      agent: 'codex',
      job: 'file-question',
      status: 'failed',
      session: 'orch-test-session',
      repo: 'continuation-fixture',
    })
    const prior = addRun({
      agent: 'codex',
      job: 'file-question',
      status: 'failed',
      parent: root,
      turn: 2,
      session: 'orch-test-session',
    })
    db()
      .query('UPDATE run SET vendor_session=?,cwd=?,worktree=? WHERE record_id IN (?,?)')
      .run('vendor-session', dir, dir, root, prior)

    const resumed = await continueRun(root, 'vendor-session message', limit)
    const artifact = db()
      .query('SELECT prompt_path,continuation_message_sha FROM run WHERE record_id=?')
      .get(resumed.childId) as {
      prompt_path: string
      continuation_message_sha: string
    }

    trackResidue(artifact.prompt_path)
    expect(readFileSync(artifact.prompt_path, 'utf8')).toBe('vendor-session message')
    expect(artifact.continuation_message_sha).toBe(
      continuationMessageBinding('vendor-session message').sha256,
    )
  })

  test('checkpoint continuation launched through continueRun ends with the message', async () => {
    const root = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'failed',
      session: 'orch-test-session',
      repo: 'continuation-fixture',
    })
    const repository = trackResidue(join(dir, `continue-checkpoint-${root}`))
    mkdirSync(repository)
    for (const argv of [
      ['init', '-q'],
      ['config', 'user.email', 'fixture@example.test'],
      ['config', 'user.name', 'Fixture'],
    ]) {
      expect(Bun.spawnSync(['git', ...argv], { cwd: repository }).exitCode).toBe(0)
    }
    writeFileSync(join(repository, 'tracked.txt'), 'root\n')
    expect(Bun.spawnSync(['git', 'add', 'tracked.txt'], { cwd: repository }).exitCode).toBe(0)
    expect(Bun.spawnSync(['git', 'commit', '-qm', 'fixture'], { cwd: repository }).exitCode).toBe(0)
    expect(
      Bun.spawnSync(['git', 'branch', 'DEV-1570-checkpoint'], { cwd: repository }).exitCode,
    ).toBe(0)
    upsertProject({ recordId: newRecordId(), name: 'continuation-fixture', path: repository })
    const originalPrompt = trackResidue(join(dir, `continue-checkpoint-${root}.prompt.txt`))
    writeFileSync(originalPrompt, 'ORIGINAL SPEC')
    db()
      .query(
        `UPDATE run SET cwd=?,worktree=?,branch=?,prompt_path=?,vendor_session=NULL
         WHERE record_id=?`,
      )
      .run(
        repository,
        join(repository, 'released-worktree'),
        'DEV-1570-checkpoint',
        originalPrompt,
        root,
      )

    const message = 'Apply the architect review exactly.\n'
    const resumed = await continueRun(root, message, limit)
    const artifact = db()
      .query('SELECT prompt_path FROM run WHERE record_id=?')
      .get(resumed.childId) as { prompt_path: string }
    trackResidue(artifact.prompt_path)
    const prompt = readFileSync(artifact.prompt_path, 'utf8')
    expect(prompt).toStartWith('CHECKPOINT RESUME\n')
    expect(prompt.endsWith(message)).toBe(true)
  })

  test('a worktree stopped mid-rebase with no checkpoint row continues its vendor session', async () => {
    const root = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'failed',
      session: 'orch-test-session',
      repo: 'continuation-fixture',
    })
    const { repository, branch } = stoppedRebaseRepository(root)
    upsertProject({ recordId: newRecordId(), name: 'continuation-fixture', path: repository })
    const originalPrompt = trackResidue(join(dir, `continue-rebase-${root}.prompt.txt`))
    writeFileSync(originalPrompt, 'ORIGINAL SPEC')
    db()
      .query(
        `UPDATE run SET vendor_session=?,cwd=?,worktree=?,branch=?,prompt_path=? WHERE record_id=?`,
      )
      .run('vendor-session', repository, repository, branch, originalPrompt, root)
    expect(
      db().query('SELECT COUNT(*) n FROM run_checkpoint WHERE run_record_id=?').get(root),
    ).toEqual({ n: 0 })

    const resumed = await continueRun(root, 'finish the rebase and land the slice', limit)
    const child = db()
      .query(
        'SELECT prompt_path,vendor_session,parent_run_record_id,turn FROM run WHERE record_id=?',
      )
      .get(resumed.childId) as {
      prompt_path: string
      vendor_session: string | null
      parent_run_record_id: string
      turn: number
    }
    trackResidue(child.prompt_path)

    // The resume kind is continue, not fresh-session: only continue passes the
    // recorded vendor session into the new turn's row (`spec.resume.session`),
    // and the block below is provenance the worker must clear, not a restart.
    expect(child.vendor_session).toBe('vendor-session')
    expect(child.parent_run_record_id).toBe(root)
    expect(child.turn).toBe(2)
    // The rebase detached HEAD, so the child is cut a tree at the branch tip and
    // never sees the operation: the block must not claim the rebase is in it.
    const prompt = readFileSync(child.prompt_path, 'utf8')
    expect(prompt).toStartWith(
      'CHECKPOINT RESUME\n' +
        `The run's retained tree at ${repository} had a rebase in progress; ` +
        'this tree starts from the branch tip without it.\n',
    )
    expect(prompt).not.toContain('in this worktree')
    // No checkpoint row, so the turn continues its own session and the block is
    // context in front of the message; the reaped-spec path below pins that.
    expect(prompt).not.toContain('ORIGINAL SPEC')
  })

  test('a continuation with no checkpoint row survives a reaped prompt file', async () => {
    const root = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'failed',
      session: 'orch-test-session',
      repo: 'continuation-fixture',
    })
    const { repository, branch } = stoppedRebaseRepository(root)
    upsertProject({ recordId: newRecordId(), name: 'continuation-fixture', path: repository })
    db()
      .query(
        `UPDATE run SET vendor_session=?,cwd=?,worktree=?,branch=?,prompt_path=? WHERE record_id=?`,
      )
      .run(
        'vendor-session',
        repository,
        repository,
        branch,
        join(dir, `reaped-prompt-${root}.prompt.txt`),
        root,
      )

    const resumed = await continueRun(root, 'finish the rebase and land the slice', limit)
    const child = db()
      .query('SELECT prompt_path,vendor_session FROM run WHERE record_id=?')
      .get(resumed.childId) as { prompt_path: string; vendor_session: string | null }
    trackResidue(child.prompt_path)

    expect(child.vendor_session).toBe('vendor-session')
    const prompt = readFileSync(child.prompt_path, 'utf8')
    expect(prompt).toBe(
      'CHECKPOINT RESUME\n' +
        `The run's retained tree at ${repository} had a rebase in progress; ` +
        'this tree starts from the branch tip without it.\n\n' +
        'finish the rebase and land the slice',
    )
  })

  test('a released reader with an unavailable base refuses before creating a turn', async () => {
    const root = insert('ok')
    db()
      .query('UPDATE run SET vendor_session=?,worktree=NULL,base_commit=? WHERE record_id=?')
      .run('vendor-session', 'missing-reader-base', root)

    await expect(continueRun(root, 'deliver queued messages', limit)).rejects.toThrow(
      'read-only base commit missing-reader-base is unavailable',
    )
    expect(db().query('SELECT COUNT(*) n FROM run WHERE parent_run_record_id=?').get(root)).toEqual(
      {
        n: 0,
      },
    )
  })

  test('a provision refusal leaves a stopped root stopped and creates no child turn', async () => {
    const root = insert('stopped', 'implement')
    const projectPath = trackResidue(join(dir, `continue-provision-${root}`))
    mkdirSync(projectPath)
    const initialized = Bun.spawnSync(['git', 'init', '--quiet'], { cwd: projectPath })
    if (initialized.exitCode !== 0) {
      throw new Error(initialized.stderr.toString().trim() || 'git init failed')
    }
    upsertProject({
      recordId: newRecordId(),
      name: 'continuation-fixture',
      path: projectPath,
      settings: { worktree: { seeds: ['minimal'] } },
    })
    db()
      .query(
        `UPDATE run SET vendor_session=?,cwd=?,worktree=?,branch=?,branch_kept_tip=? WHERE record_id=?`,
      )
      .run(
        'vendor-session',
        projectPath,
        join(projectPath, 'released-tree'),
        'DEV-1560-continue',
        'abc123def',
        root,
      )

    await expect(continueRun(root, 'continue after stop', limit)).rejects.toThrow(
      /cannot be continued: it must recreate its worktree and has no recorded launch seed/,
    )
    expect(db().query('SELECT status FROM run WHERE record_id=?').get(root)).toEqual({
      status: 'stopped',
    })
    expect(db().query('SELECT COUNT(*) n FROM run WHERE parent_run_record_id=?').get(root)).toEqual(
      {
        n: 0,
      },
    )
  })

  test('a repository-free continuation needs neither a project nor a reader base', async () => {
    const root = addRun({
      agent: 'codex',
      job: 'summarize',
      status: 'ok',
      session: 'orch-test-session',
    })
    db()
      .query(
        'UPDATE run SET vendor_session=?,cwd=?,worktree=NULL,base_commit=NULL WHERE record_id=?',
      )
      .run('vendor-session', dir, root)

    const resumed = await continueRun(root, 'summarize one more thing', limit)

    expect(resumed).toEqual({ childId: expect.stringMatching(/^[0-9a-f-]{36}$/), job: 'summarize' })
  })
})
