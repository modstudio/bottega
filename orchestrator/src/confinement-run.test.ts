import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { cloneRepository, hermeticGitEnv } from '../test/fixtures/git.ts'
import { reviewReply, workerReply } from '../test/fixtures/replies.ts'
import { dir } from '../test/fixtures/store.ts'
import { AGENTS } from './agents.ts'
import { db } from './db.ts'
import { upsertProject } from './projects.ts'
import { snapshotRegisteredCheckouts } from './prompt-retarget.ts'
import { candidates } from './route.ts'
import { run as runJob } from './run.ts'
import { removeFor } from './worktree.ts'
import { parseConfinement } from "./confinement.ts"
import { scriptedTransportSequence } from "../test/fake-transport.ts"
describe('outside-worktree write observation', () => {
const scripts: string[] = []
const agentScript = (name: string) => { const path = join(dir, name); scripts.push(path); return path }
afterEach(() => { for (const script of scripts) rmSync(script, { force: true }); scripts.length = 0; rmSync(join(dir, '.claude'), { recursive: true, force: true }) })
const git = (cwd: string, ...args: string[]) => { const p = Bun.spawnSync(['git', ...args], { cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' }); if (p.exitCode !== 0) throw new Error(p.stderr.toString()); return p.stdout.toString().trim() }
const repository = () => { const repo = cloneRepository('orch-outside-write-'); writeFileSync(join(repo, 'tracked.txt'), 'base\n'); git(repo, 'add', 'tracked.txt'); git(repo, 'commit', '-m', 'fixture'); return repo }
const installConfinementTransport = (outputs: string[]) => scriptedTransportSequence(
  outputs.map((output) => [
    { kind: 'stdout' as const, chunk: output },
    { kind: 'completed' as const, output },
  ]),
  ({ cwd }) => {
    const external = process.env.ORCH_TEST_EXTERNAL_WRITE
    if (external) writeFileSync(external, 'outside\n')
    const inside = process.env.ORCH_TEST_INSIDE_WRITE
    if (inside) writeFileSync(join(cwd, inside), 'inside\n')
    const hidden = process.env.ORCH_TEST_HIDE_GIT
    if (hidden) renameSync(join(hidden, '.git'), join(hidden, '.git-hidden'))
  },
).install()
test('a real run records an external write and a clean run records none', async () => {
    const watched = repository()
    const script = agentScript('outside-write-agent.sh')
    writeFileSync(script, `#!/bin/sh
if [ -n "$ORCH_TEST_EXTERNAL_WRITE" ]; then printf 'outside\\n' > "$ORCH_TEST_EXTERNAL_WRITE"; fi
if [ -n "$ORCH_TEST_INSIDE_WRITE" ]; then printf 'inside\\n' > "$ORCH_TEST_INSIDE_WRITE"; fi
printf '%s\\n' '{"type":"system","subtype":"init"}' '{"type":"result","result":"answer"}'
`)
    chmodSync(script, 0o755)
    upsertProject({ name: 'watched-project', path: watched })
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    const priorTarget = process.env.ORCH_TEST_EXTERNAL_WRITE
    const priorInside = process.env.ORCH_TEST_INSIDE_WRITE
    process.env.ORCH_DEPTH = '0'
    installConfinementTransport(['answer', 'answer', 'answer'])
    try {
      grok.bin = script
      process.env.ORCH_TEST_EXTERNAL_WRITE = join(watched, 'written-by-run.txt')
      const dirty = await runJob({ job: 'file-question', prompt: 'write outside', cwd: dir, agent: 'grok' })
      const dirtyRunId = dirty.id
      const recorded = db().query(
        `SELECT status, failure_kind, error, output_path,
                worktree, branch, base_commit, worktree_source, confinement
           FROM run WHERE id=?`,
      ).get(dirtyRunId!) as {
        status: string; failure_kind: string | null; error: string | null
        output_path: string
        worktree: string | null; branch: string | null; base_commit: string | null
        worktree_source: 'recipe' | 'git' | 'readonly_recipe' | null
        confinement: string | null
      }
      expect(recorded.status).toBe('ok')
      expect(recorded.failure_kind).toBeNull()
      expect(db().query(
        `SELECT resource_kind, event_kind, resource_key, run_id FROM contention WHERE run_id=?`,
      ).get(dirtyRunId!)).toBeNull()
      const event = parseConfinement(recorded.confinement)
      expect(event?.classification).toBe('non_overlapping')
      expect(event?.attribution).toBe('unattributed')
      expect(event?.divergentPaths).toContain('written-by-run.txt')
      expect(readFileSync(recorded.output_path, 'utf8')).toContain('answer')
      expect(db().query('SELECT id FROM run WHERE retry_of=?').get(dirtyRunId!)).toBeNull()
      expect(candidates('file-question').find((item) => item.agent === 'grok'))
        .toMatchObject({ failures: 0, evidence: 0, score: null })
      if (recorded.worktree && recorded.branch && recorded.base_commit) {
        expect(removeFor({
          path: recorded.worktree, branch: recorded.branch, base: recorded.base_commit,
          repoRoot: dir, source: recorded.worktree_source ?? undefined,
        }, dir).removed).toBe(true)
      }

      rmSync(join(watched, 'written-by-run.txt'))
      delete process.env.ORCH_TEST_EXTERNAL_WRITE
      process.env.ORCH_TEST_INSIDE_WRITE = 'inside-only.txt'
      const clean = await runJob({
        job: 'file-question', prompt: 'write inside', cwd: dir, agent: 'grok', keepTree: true,
      })
      const cleanRecorded = db().query(
        'SELECT status, failure_kind FROM run WHERE id=?',
      ).get(clean.id) as { status: string; failure_kind: string | null }
      expect(cleanRecorded).toMatchObject({ status: 'ok', failure_kind: null })
      expect(clean.worktree && existsSync(join(clean.worktree.path, 'inside-only.txt'))).toBe(true)
      expect(snapshotRegisteredCheckouts()).toEqual([
        { project: 'watched-project', path: watched, status: '', head: 'main', expectedHead: null },
      ])

      process.env.ORCH_TEST_INSIDE_WRITE = 'inside-resume.txt'
      let resumedRunId: number | null = null
      try {
        const resumed = await runJob({
          job: 'file-question', prompt: 'resume and escape', cwd: clean.worktree!.path,
          resume: {
            parent: clean.id, agent: 'grok', session: 'test-session', turn: 2,
            sessionId: 'orch-test-session', worktree: clean.worktree,
          },
        })
        resumedRunId = resumed.id
      } catch (error) {
        resumedRunId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(resumedRunId).not.toBeNull()
      expect(db().query(
        'SELECT status, failure_kind, parent_run_id FROM run WHERE id=?',
      ).get(resumedRunId!)).toEqual({
        status: 'ok', failure_kind: null, parent_run_id: clean.id,
      })
      expect(existsSync(join(clean.worktree!.path, 'inside-resume.txt'))).toBe(true)
      if (clean.worktree) expect(removeFor(clean.worktree, clean.worktree.repoRoot).removed).toBe(true)
    } finally {
      grok.bin = previousBin
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      if (priorTarget === undefined) delete process.env.ORCH_TEST_EXTERNAL_WRITE
      else process.env.ORCH_TEST_EXTERNAL_WRITE = priorTarget
      if (priorInside === undefined) delete process.env.ORCH_TEST_INSIDE_WRITE
      else process.env.ORCH_TEST_INSIDE_WRITE = priorInside
      rmSync(watched, { recursive: true, force: true })
    }
  })

test('no-worktree and resumed runs watch registered caller checkouts', async () => {
    const repo = repository()
    const caller = join(repo, '.claude', 'worktrees', 'distinct-caller')
    const script = agentScript('DEV-372-identity-watch-agent.sh')
    writeFileSync(script, `#!/bin/sh
if [ -n "$ORCH_TEST_EXTERNAL_WRITE" ]; then printf 'outside\\n' > "$ORCH_TEST_EXTERNAL_WRITE"; fi
printf '%s\\n' '{"type":"system","subtype":"init"}' '{"type":"result","result":"answer"}'
`)
    chmodSync(script, 0o755)
    upsertProject({ name: 'identity-watch-project', path: repo })
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    const priorTarget = process.env.ORCH_TEST_EXTERNAL_WRITE
    process.env.ORCH_DEPTH = '0'
    grok.bin = script
    installConfinementTransport(['answer', 'answer', 'answer'])
    try {
      process.env.ORCH_TEST_EXTERNAL_WRITE = join(repo, 'summary-edit.txt')
      const summary = await runJob({
        job: 'summarize', prompt: 'watch the caller without a worktree', cwd: repo, agent: 'grok',
      })
      expect(summary.worktree).toBeNull()
      const summaryRow = db().query(
        'SELECT status, failure_kind, confinement FROM run WHERE id=?',
      ).get(summary.id) as { status: string; failure_kind: string | null; confinement: string }
      expect(summaryRow).toMatchObject({ status: 'ok', failure_kind: null })
      const summaryEvent = parseConfinement(summaryRow.confinement)
      expect(summaryEvent).toMatchObject({
        classification: 'non_overlapping', attribution: 'unattributed',
      })
      expect(summaryEvent?.after.map(({ path }) => path)).toContain(realpathSync(repo))
      rmSync(join(repo, 'summary-edit.txt'))

      delete process.env.ORCH_TEST_EXTERNAL_WRITE
      const first = await runJob({
        job: 'file-question', prompt: 'create a resumable chain', cwd: repo, agent: 'grok', keepTree: true,
      })
      expect(first.worktree).not.toBeNull()
      mkdirSync(dirname(caller), { recursive: true })
      const added = Bun.spawnSync(['git', 'worktree', 'add', '-b', 'DEV-372-distinct-caller', caller], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (added.exitCode !== 0) throw new Error(added.stderr.toString())
      process.env.ORCH_TEST_EXTERNAL_WRITE = join(caller, 'resume-edit.txt')
      const resumed = await runJob({
        job: 'file-question', prompt: 'resume from a distinct caller checkout', cwd: caller,
        resume: {
          parent: first.id, agent: 'grok', session: 'test-session', turn: 2,
          sessionId: 'orch-test-session', worktree: first.worktree,
        },
      })
      const resumedRow = db().query(
        'SELECT status, failure_kind, confinement FROM run WHERE id=?',
      ).get(resumed.id) as { status: string; failure_kind: string | null; confinement: string }
      expect(resumedRow).toMatchObject({ status: 'ok', failure_kind: null })
      const resumedEvent = parseConfinement(resumedRow.confinement)
      expect(resumedEvent?.classification).toBe('non_overlapping')
      expect(resumedEvent?.after.map(({ path }) => path)).toContain(realpathSync(caller))
      if (first.worktree) expect(removeFor(first.worktree, first.worktree.repoRoot).removed).toBe(true)
    } finally {
      grok.bin = previousBin
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      if (priorTarget === undefined) delete process.env.ORCH_TEST_EXTERNAL_WRITE
      else process.env.ORCH_TEST_EXTERNAL_WRITE = priorTarget
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('a checkout that cannot be sampled after launch fails confinement verification', async () => {
    const watched = repository()
    const hiddenGit = join(watched, '.git-hidden')
    const script = agentScript('hide-watched-git-agent.sh')
    writeFileSync(script, `#!/bin/sh
mv "$ORCH_TEST_HIDE_GIT/.git" "$ORCH_TEST_HIDE_GIT/.git-hidden"
printf '%s\\n' '{"type":"system","subtype":"init"}' '{"type":"result","result":"answer"}'
`)
    chmodSync(script, 0o755)
    upsertProject({ name: 'unverifiable-project', path: watched })
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    const priorTarget = process.env.ORCH_TEST_HIDE_GIT
    process.env.ORCH_DEPTH = '0'
    process.env.ORCH_TEST_HIDE_GIT = watched
    let runId: number | null = null
    installConfinementTransport(['answer'])
    try {
      grok.bin = script
      try {
        await runJob({ job: 'file-question', prompt: 'hide git', cwd: dir, agent: 'grok' })
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(runId).not.toBeNull()
      renameSync(hiddenGit, join(watched, '.git'))
      const row = db().query(
        `SELECT status, failure_kind, error, worktree, branch, base_commit, worktree_source
           FROM run WHERE id=?`,
      ).get(runId!) as {
        status: string; failure_kind: string; error: string
        worktree: string | null; branch: string | null; base_commit: string | null
        worktree_source: 'recipe' | 'git' | 'readonly_recipe' | null
      }
      expect(row.status).toBe('failed')
      expect(row.failure_kind).toBe('confinement_unverified')
      expect(row.error).toContain(watched)
      expect(row.error).toContain('after snapshot:')
      expect(row.error).toContain('not a git repository')
      expect(Buffer.byteLength(row.error)).toBeLessThanOrEqual(1500)
      expect(candidates('file-question').find((item) => item.agent === 'grok'))
        .toMatchObject({ failures: 0, evidence: 0, score: null })
      if (row.worktree && row.branch && row.base_commit) {
        expect(removeFor({
          path: row.worktree, branch: row.branch, base: row.base_commit,
          repoRoot: dir, source: row.worktree_source ?? undefined,
        }, dir).removed).toBe(true)
      }
    } finally {
      grok.bin = previousBin
      if (existsSync(hiddenGit) && !existsSync(join(watched, '.git'))) {
        renameSync(hiddenGit, join(watched, '.git'))
      }
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      if (priorTarget === undefined) delete process.env.ORCH_TEST_HIDE_GIT
      else process.env.ORCH_TEST_HIDE_GIT = priorTarget
      rmSync(watched, { recursive: true, force: true })
    }
  })

test('an overlapping outside edit blocks with attribution and a contention row', async () => {
    const repo = repository()
    const caller = join(repo, '.claude', 'worktrees', 'dirty-caller')
    mkdirSync(dirname(caller), { recursive: true })
    const added = Bun.spawnSync(['git', 'worktree', 'add', '-b', 'DEV-372-dirty-caller', caller], {
      cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (added.exitCode !== 0) throw new Error(added.stderr.toString())
    const script = agentScript('DEV-372-overlap-agent.sh')
    writeFileSync(script, `#!/bin/sh
printf 'outside\\n' > "$ORCH_TEST_EXTERNAL_WRITE"
printf 'inside\\n' > overlap.txt
printf '%s\\n' '${JSON.stringify(workerReply({ files_changed: ['overlap.txt'] }))}'
`)
    chmodSync(script, 0o755)
    upsertProject({ name: 'overlap-project', path: repo, settings: { trunk: 'main', gate: 'true' } })
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    const priorTarget = process.env.ORCH_TEST_EXTERNAL_WRITE
    const priorInside = process.env.ORCH_TEST_INSIDE_WRITE
    process.env.ORCH_DEPTH = '0'
    process.env.ORCH_TEST_EXTERNAL_WRITE = join(caller, 'overlap.txt')
    process.env.ORCH_TEST_INSIDE_WRITE = 'overlap.txt'
    let runId: number | null = null
    installConfinementTransport([JSON.stringify(workerReply({ files_changed: ['overlap.txt'] }))])
    try {
      grok.bin = script
      try {
        await runJob({ job: 'implement', prompt: 'overlap', cwd: caller, agent: 'grok', noFailover: true })
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(runId).not.toBeNull()
      const recorded = db().query(
        'SELECT status, failure_kind, error, confinement FROM run WHERE id=?',
      ).get(runId!) as { status: string; failure_kind: string; error: string; confinement: string }
      expect(recorded.status).toBe('failed')
      expect(recorded.failure_kind).toBe('escaped')
      expect(recorded.error).toContain('confinement: overlapping outside change')
      expect(recorded.error).toContain('attribution: unattributed')
      const event = parseConfinement(recorded.confinement)
      expect(event?.classification).toBe('overlapping')
      expect(event?.checkout).toBe(realpathSync(caller))
      expect(event?.attribution).toBe('unattributed')
      expect(event?.overlappingPaths).toContain('overlap.txt')
      expect(db().query(
        'SELECT resource_kind, resource_key, event_kind FROM contention WHERE run_id=?',
      ).get(runId!)).toEqual({
        resource_kind: 'main_checkout', resource_key: realpathSync(caller), event_kind: 'invalidation',
      })
    } finally {
      grok.bin = previousBin
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      if (priorTarget === undefined) delete process.env.ORCH_TEST_EXTERNAL_WRITE
      else process.env.ORCH_TEST_EXTERNAL_WRITE = priorTarget
      if (priorInside === undefined) delete process.env.ORCH_TEST_INSIDE_WRITE
      else process.env.ORCH_TEST_INSIDE_WRITE = priorInside
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('a diverged lens keeps its findings and records the review', async () => {
    const repo = repository()
    const script = agentScript('DEV-372-lens-agent.sh')
    writeFileSync(script, `#!/bin/sh
printf 'stray\\n' > "$ORCH_TEST_EXTERNAL_WRITE"
printf '%s\\n' '{"type":"system","subtype":"init"}'
printf '%s\\n' ${JSON.stringify(JSON.stringify({
      type: 'result', subtype: 'success', result: JSON.stringify({
        ...reviewReply(1),
        provenance: {
          ...reviewReply(1).provenance,
          files_covered: ['tracked.txt'],
          commands_run: ['git diff -- tracked.txt'],
        },
      }),
    }))}
`)
    chmodSync(script, 0o755)
    upsertProject({ name: 'lens-project', path: repo })
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    const priorTarget = process.env.ORCH_TEST_EXTERNAL_WRITE
    process.env.ORCH_DEPTH = '0'
    process.env.ORCH_TEST_EXTERNAL_WRITE = join(repo, 'stray-lens.txt')
    installConfinementTransport([JSON.stringify({
      ...reviewReply(1),
      provenance: {
        ...reviewReply(1).provenance,
        files_covered: ['tracked.txt'],
        commands_run: ['git diff -- tracked.txt'],
      },
    })])
    try {
      grok.bin = script
      let result: Awaited<ReturnType<typeof runJob>>
      try {
        result = await runJob({
          job: 'review-lens', prompt: 'review this', cwd: repo, agent: 'grok', lens: 'craft',
        })
      } catch (error) {
        const id = (error as Error & { runId?: number }).runId
        throw new Error(`${(error as Error).message} row=${JSON.stringify(id ? db().query('SELECT status, failure_kind, error FROM run WHERE id=?').get(id) : null)}`)
      }
      expect(result.status).toBe('ok')
      const recorded = db().query(
        'SELECT failure_kind, confinement, output_path FROM run WHERE id=?',
      ).get(result.id) as { failure_kind: string | null; confinement: string; output_path: string }
      expect(recorded.failure_kind).toBeNull()
      const event = parseConfinement(recorded.confinement)
      expect(event?.classification).toBe('non_overlapping')
      expect(event?.attribution).toBe('unattributed')
      expect(readFileSync(recorded.output_path, 'utf8')).toContain('findings')
      expect(db().query('SELECT review_id FROM review_lens WHERE run_id=?').get(result.id)).toBeTruthy()
    } finally {
      grok.bin = previousBin
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      if (priorTarget === undefined) delete process.env.ORCH_TEST_EXTERNAL_WRITE
      else process.env.ORCH_TEST_EXTERNAL_WRITE = priorTarget
      rmSync(repo, { recursive: true, force: true })
    }
  })

})
