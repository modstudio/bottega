import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync, mkdirSync, chmodSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AGENTS, db, dir, hermeticGitEnv, run, upsertProject, workerReply } from "../fixture.ts"
import { parseConfinement } from "../../src/confinement.ts"
describe('run git process boundary', () => {
const git = (cwd: string, ...args: string[]) => { const p = Bun.spawnSync(['git', ...args], { cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' }); if (p.exitCode !== 0) throw new Error(p.stderr.toString()); return p.stdout.toString().trim() }
const repository = () => { const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-outside-write-'))); git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.email', 'orch-test@example.invalid'); git(repo, 'config', 'user.name', 'Orch Test'); writeFileSync(join(repo, 'tracked.txt'), 'base\n'); git(repo, 'add', 'tracked.txt'); git(repo, 'commit', '-m', 'fixture'); return repo }
test('own-checkout git pull from a worktree completes and is classified unattributed', async () => {
    const repo = repository()
    const caller = join(repo, '.claude', 'worktrees', 'session')
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
    appendFileSync(join(repo, '.git', 'info', 'exclude'), '.claude/\n')
    git(repo, 'worktree', 'add', '-b', 'session-caller', caller)
    const script = join(dir, 'DEV-372-pull-agent.sh')
    writeFileSync(script, `#!/bin/sh
MAIN="$ORCH_TEST_MAIN"
printf 'pulled\\n' > "$MAIN/extra.txt"
env -i HOME="$HOME" PATH="$PATH" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
  git -C "$MAIN" -c user.email=orch-test@example.invalid -c user.name='Orch Test' add extra.txt
env -i HOME="$HOME" PATH="$PATH" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
  git -C "$MAIN" -c user.email=orch-test@example.invalid -c user.name='Orch Test' commit -m 'simulated pull'
printf 'inside\\n' > pulled.txt
git add pulled.txt
git -c user.email=orch-test@example.invalid -c user.name='Orch Test' commit -m 'DEV-372 pull-safe' >/dev/null
printf '%s\\n' '{"type":"system","subtype":"init"}'
printf '%s\\n' ${JSON.stringify(JSON.stringify({
      type: 'result', subtype: 'success',
      result: JSON.stringify(workerReply({ files_changed: ['pulled.txt'] })),
    }))}
`)
    chmodSync(script, 0o755)
    upsertProject({ name: 'pull-project', path: repo, settings: { trunk: 'main', gate: 'true' } })
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    const priorMain = process.env.ORCH_TEST_MAIN
    process.env.ORCH_DEPTH = '0'
    process.env.ORCH_TEST_MAIN = repo
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
      const script = join(dir, `DEV-372-hook-${job}.sh`)
      writeFileSync(script, `#!/bin/sh
printf 'x\\n' > hooked.txt
git add hooked.txt
git -c user.email=orch-test@example.invalid -c user.name='Orch Test' commit -m 'DEV-372 worker commit'
printf '%s\\n' '${JSON.stringify(workerReply({ files_changed: ['hooked.txt'] }))}'
`)
      chmodSync(script, 0o755)
      upsertProject({ name: `hooks-${job}`, path: repo, settings: { gate: 'true' } })
      const grok = AGENTS.grok!
      const previousBin = grok.bin
      const priorDepth = process.env.ORCH_DEPTH
      process.env.ORCH_DEPTH = '0'
      try {
        grok.bin = script
        const result = await run({ job, prompt: 'commit', cwd: repo, agent: 'grok', noFailover: true })
        expect(result.status).toBe('ok')
        expect(existsSync(marker)).toBe(false)
      } finally {
        grok.bin = previousBin
        if (priorDepth === undefined) delete process.env.ORCH_DEPTH
        else process.env.ORCH_DEPTH = priorDepth
        rmSync(repo, { recursive: true, force: true })
      }
    }
  })

})
