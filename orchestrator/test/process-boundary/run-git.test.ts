import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync, mkdirSync, chmodSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { AGENTS, db, dir, hermeticGitEnv, run, upsertProject, workerReply } from "../fixture.ts"
import { stubWorker } from '../stub-worker.ts'
import { parseConfinement } from "../../src/confinement.ts"
describe('run git process boundary', () => {
const git = (cwd: string, ...args: string[]) => { const p = Bun.spawnSync(['git', ...args], { cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' }); if (p.exitCode !== 0) throw new Error(p.stderr.toString()); return p.stdout.toString().trim() }
const repository = () => { const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-outside-write-'))); git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.email', 'orch-test@example.invalid'); git(repo, 'config', 'user.name', 'Orch Test'); writeFileSync(join(repo, 'tracked.txt'), 'base\n'); git(repo, 'add', 'tracked.txt'); git(repo, 'commit', '-m', 'fixture'); return repo }
const grokOutput = (filesChanged: string[]) => [
  JSON.stringify({ type: 'system', subtype: 'init' }),
  JSON.stringify({
    type: 'result', subtype: 'success',
    result: JSON.stringify(workerReply({ files_changed: filesChanged })),
  }),
].join('\n')
test('own-checkout git pull from a worktree completes and is classified unattributed', async () => {
    const repo = repository()
    const caller = join(repo, '.claude', 'worktrees', 'session')
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
    appendFileSync(join(repo, '.git', 'info', 'exclude'), '.claude/\n')
    git(repo, 'worktree', 'add', '-b', 'session-caller', caller)
    const script = stubWorker({
      commands: [
        'printf "pulled\\n" > "$ORCH_TEST_MAIN/extra.txt"',
        'env -i HOME="$HOME" PATH="$PATH" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -C "$ORCH_TEST_MAIN" -c user.email=orch-test@example.invalid -c user.name="Orch Test" add extra.txt',
        'env -i HOME="$HOME" PATH="$PATH" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -C "$ORCH_TEST_MAIN" -c user.email=orch-test@example.invalid -c user.name="Orch Test" commit -m "simulated pull" >/dev/null',
      ],
      commits: true,
    })
    upsertProject({ name: 'pull-project', path: repo, settings: { trunk: 'main', gate: 'true' } })
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    const priorMain = process.env.ORCH_TEST_MAIN
    const priorOutput = process.env.ORCH_STUB_OUTPUT
    process.env.ORCH_DEPTH = '0'
    process.env.ORCH_TEST_MAIN = repo
    process.env.ORCH_STUB_OUTPUT = grokOutput(['worker.txt'])
    try {
      grok.bin = script
      const result = await run({
        job: 'implement', prompt: 'pull-safe', cwd: caller, agent: 'grok', noFailover: true,
      })
      expect(result.status).toBe('ok')
      expect(git(repo, 'log', '-1', '--pretty=%s')).toBe('simulated pull')
      const recorded = db().query(
        'SELECT failure_kind, confinement, branch FROM run WHERE id=?',
      ).get(result.id) as { failure_kind: string | null; confinement: string | null; branch: string }
      expect(recorded.failure_kind).toBeNull()
      const event = parseConfinement(recorded.confinement)
      expect(event?.classification).toBe('edit_commit_cycle')
      expect(event?.attribution).toBe('unattributed')
    } finally {
      grok.bin = previousBin
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      if (priorMain === undefined) delete process.env.ORCH_TEST_MAIN
      else process.env.ORCH_TEST_MAIN = priorMain
      if (priorOutput === undefined) delete process.env.ORCH_STUB_OUTPUT
      else process.env.ORCH_STUB_OUTPUT = priorOutput
      rmSync(dirname(script), { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('worker commits skip project commit-msg hooks for implement and fix', async () => {
    for (const job of ['implement', 'fix'] as const) {
      const repo = repository()
      const hooks = join(repo, '.githooks')
      mkdirSync(hooks)
      const marker = join(repo, `hook-fired-${job}`)
      writeFileSync(join(hooks, 'commit-msg'), `#!/bin/sh\nprintf fired > '${marker}'\n`)
      chmodSync(join(hooks, 'commit-msg'), 0o755)
      git(repo, 'config', 'core.hooksPath', hooks)
      const script = stubWorker({ commits: true })
      upsertProject({ name: `hooks-${job}`, path: repo, settings: { gate: 'true' } })
      const grok = AGENTS.grok!
      const previousBin = grok.bin
      const priorDepth = process.env.ORCH_DEPTH
      const priorOutput = process.env.ORCH_STUB_OUTPUT
      process.env.ORCH_DEPTH = '0'
      process.env.ORCH_STUB_OUTPUT = grokOutput(['worker.txt'])
      try {
        grok.bin = script
        const result = await run({ job, prompt: 'commit', cwd: repo, agent: 'grok', noFailover: true })
        expect(result.status).toBe('ok')
        expect(existsSync(marker)).toBe(false)
      } finally {
        grok.bin = previousBin
        if (priorDepth === undefined) delete process.env.ORCH_DEPTH
        else process.env.ORCH_DEPTH = priorDepth
        if (priorOutput === undefined) delete process.env.ORCH_STUB_OUTPUT
        else process.env.ORCH_STUB_OUTPUT = priorOutput
        rmSync(dirname(script), { recursive: true, force: true })
        rmSync(repo, { recursive: true, force: true })
      }
    }
  })

})
