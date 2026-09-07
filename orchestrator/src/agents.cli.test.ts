import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runJson, AGENTS, NOT_EVIDENCE, READONLY_PREAMBLE, SHARED_OUTPUT_REASON, addRun, candidates, db, declaredCreate, dir, excludeSharedOutputRuns, hermeticGitEnv, pendingForSession, removeProject, retryModelForAgent, reviewReply, run, runDetail, runJob, score, upsertProject, weigh, writingFailoverRefusal } from '../test/fixture.ts'

describe('retry keeps the work on the same agent', () => {
  test('a changed retry agent uses its pin unless an explicit model overrides it', () => {
    expect(retryModelForAgent('grok', 'grok-4.6', 'grok')).toBe('grok-4.6')
    expect(retryModelForAgent('grok', 'grok-4.6', 'codex')).toBe(AGENTS.codex!.model)
    expect(retryModelForAgent('grok', 'grok-4.6', 'codex', 'explicit-model'))
      .toBe('explicit-model')
  })

  test('a retry is linked to what it re-attempts', () => {
    const first = addRun({ agent: 'codex', job: 'review-lens', status: 'failed' })
    const second = addRun({ agent: 'codex', job: 'review-lens' })
    db().query('UPDATE run SET retry_of=? WHERE id=?').run(first, second)
    const row = db().query('SELECT retry_of FROM run WHERE id=?').get(second) as { retry_of: number }
    expect(row.retry_of).toBe(first)
  })

  test('a quota failure is retained but its successful retry is the only evidence', () => {
    const first = addRun({ agent: 'codex', job: 'craft', status: 'failed', kind: 'quota' })
    const second = addRun({ agent: 'codex', job: 'craft' })
    db().query('UPDATE run SET retry_of=? WHERE id=?').run(first, second)
    score(second, 'full', 'right')
    const c = candidates('craft').find((x) => x.agent === 'codex')!
    expect(c.failures).toBe(0)
    expect(c.scored).toBe(1)
    expect(c.evidence).toBe(1)
  })

  const CLI = new URL('cli.ts', import.meta.url).pathname
  const orch = (args: string[], extraEnv: Record<string, string> = {}) => {
    const p = Bun.spawnSync([process.execPath, CLI, ...args], {
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session',
        ...extraEnv,
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    return {
      code: p.exitCode,
      out: new TextDecoder().decode(p.stdout),
      err: new TextDecoder().decode(p.stderr),
    }
  }
  const occurrences = (hay: string, needle: string) => {
    let n = 0, i = 0
    while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length }
    return n
  }
  const boundBeside = (promptPath: string) => promptPath.replace(/\.prompt\.txt$/, '.bound.txt')

  test('a read-only run stores the caller prompt unwrapped and the bound prompt beside it', async () => {
    const agent = AGENTS.codex!
    const origBin = agent.bin
    const origArgv = agent.argv
    agent.bin = process.execPath
    agent.argv = () => ['-e', '']
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const original = 'What does foo.ts do?'
    try {
      const result = await runJob({
        job: 'file-question', prompt: original, cwd: dir, agent: 'codex',
      })
      const row = db().query('SELECT prompt_path FROM run WHERE id=?').get(result.id) as
        { prompt_path: string }
      expect(readFileSync(row.prompt_path, 'utf8')).toBe(original)
      const bound = readFileSync(boundBeside(row.prompt_path), 'utf8')
      expect(occurrences(bound, READONLY_PREAMBLE)).toBe(1)
      expect(bound.endsWith(original)).toBe(true)
      expect(runDetail(result.id)?.prompt).toBe(original)
    } finally {
      agent.bin = origBin
      agent.argv = origArgv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('prefer persists through read-only retry and the bound prompt contains the preamble once', () => {
    const original = 'What does bar.ts do?'
    const promptPath = join(dir, 'retry-original.prompt.txt')
    writeFileSync(promptPath, original)
    const schemaPath = join(dir, 'retry-schema.json')
    writeFileSync(schemaPath, JSON.stringify({
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    }))
    const id = addRun({ agent: 'grok', job: 'file-question', status: 'failed' })
    db().query(
      `UPDATE run SET prompt_path=?, mcp=2, mcp_error='mirror: original attach failed',
                      schema_path=?, model=?, cwd=? WHERE id=?`,
    ).run(promptPath, schemaPath, 'retry-model', dir, id)

    const binDir = mkdtempSync(join(tmpdir(), 'orch-fake-grok-retry-'))
    writeFileSync(join(binDir, 'grok'), '#!/bin/sh\necho ok\nexit 0\n')
    chmodSync(join(binDir, 'grok'), 0o755)
    try {
      const r = orch(['retry', String(id)], { PATH: `${binDir}:${process.env.PATH ?? ''}` })
      expect(r.code).toBe(0)
      const child = db().query(
        `SELECT id, prompt_path, mcp, schema_path, model, retry_of, agent
           FROM run WHERE retry_of=?`,
      ).get(id) as {
        id: number; prompt_path: string; mcp: number | null; schema_path: string | null
        model: string | null; retry_of: number; agent: string
      } | null
      expect(child).not.toBeNull()
      expect(child!.agent).toBe('grok')
      expect(child!.mcp).toBe(2)
      expect(child!.schema_path).toBe(schemaPath)
      expect(child!.model).toBe('retry-model')
      expect(readFileSync(child!.prompt_path, 'utf8')).toBe(original)
      const bound = readFileSync(boundBeside(child!.prompt_path), 'utf8')
      expect(occurrences(bound, READONLY_PREAMBLE)).toBe(1)
      expect(bound.endsWith(original)).toBe(true)
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  test('bridge-only identity cannot retry an unowned read-only run', () => {
    const promptPath = join(dir, 'retry-bridge.prompt.txt')
    writeFileSync(promptPath, 'What does bar.ts do?')
    const id = addRun({ agent: 'grok', job: 'file-question', status: 'failed' })
    db().query('UPDATE run SET prompt_path=?, cwd=? WHERE id=?').run(promptPath, dir, id)
    const beforeRuns = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n
    const beforeAudit = (db().query('SELECT COUNT(*) n FROM run_mutation_audit').get() as { n: number }).n
    const result = Bun.spawnSync(
      [process.execPath, CLI, 'retry', String(id)],
      { env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: undefined, CLAUDE_CODE_BRIDGE_SESSION_ID: 'shared-bridge' },
        stdout: 'pipe', stderr: 'pipe' },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain(
      `run ${id} is unowned; CLAUDE_CODE_SESSION_ID is not set`,
    )
    expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(beforeRuns)
    expect((db().query('SELECT COUNT(*) n FROM run_mutation_audit').get() as { n: number }).n)
      .toBe(beforeAudit)
    expect(db().query('SELECT session_id FROM run WHERE id=?').get(id))
      .toEqual({ session_id: null })
  })

  test('retry refuses a foreign owner before either job shape launches', () => {
    for (const jobName of ['file-question', 'implement']) {
      const id = addRun({ agent: 'codex', job: jobName, status: 'failed' })
      db().query('UPDATE run SET session_id=? WHERE id=?').run('owner-session', id)
      const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n
      const result = orch(['retry', String(id)], { CLAUDE_CODE_SESSION_ID: 'foreign-session' })
      expect(result.code).toBe(1)
      expect(result.err).toContain(`run ${id} is owned by session owner-session`)
      expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before)
    }
  })

  test('retry of an implement run continues its session detached and prints the child id', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'orch-fake-codex-retry-'))
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    const id = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
    db().query('UPDATE run SET vendor_session=?, cwd=? WHERE id=?')
      .run('retry-session', dir, id)
    try {
      const r = orch(['retry', String(id)], {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        FORCE_COLOR: '1',
      })
      expect(r.code).toBe(0)
      const childId = Number(r.out.trim().split('\n')[0])
      expect(childId).toBeGreaterThan(0)
      orch(['wait', String(childId), '--timeout', '15'])
      const child = db().query(
        'SELECT parent_run_id, turn, vendor_session FROM run WHERE id=?',
      ).get(childId) as {
        parent_run_id: number | null; turn: number; vendor_session: string | null
      }
      expect(child.parent_run_id).toBe(id)
      expect(child.turn).toBe(2)
      expect(child.vendor_session).toBe('retry-session')
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  }, 45_000)

  test('a writing retry refuses to change agents and directs a fresh start', () => {
    const id = addRun({ agent: 'grok', job: 'implement', status: 'failed' })
    db().query('UPDATE run SET vendor_session=?, cwd=? WHERE id=?')
      .run('retry-session', dir, id)
    const r = orch(['retry', String(id), '--agent', 'codex'])
    expect(r.code).toBe(1)
    expect(r.err).toContain(
      'a writing run continues on its own agent (grok); to start over on codex: ' +
      'orch do implement --agent codex ...',
    )
    expect(db().query('SELECT COUNT(*) n FROM run WHERE parent_run_id=?').get(id))
      .toEqual({ n: 0 })
  })

  test('retry and continue give the same refusal when the chain has no session', () => {
    for (const command of ['retry', 'continue']) {
      const id = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
      const r = command === 'continue'
        ? orch([command, String(id), 'go'])
        : orch([command, String(id)])
      expect(r.code).toBe(1)
      expect(r.err).toContain(`run ${id} recorded no session id, so codex cannot be resumed`)
    }
  })
})

describe('vendor failure failover is one bounded unit of work', () => {
  const CLI = new URL('cli.ts', import.meta.url).pathname
  const orch = (...args: string[]) => {
    const p = Bun.spawnSync([process.execPath, CLI, ...args], {
      cwd: dir,
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }

  test('a repository review failover keeps its immutable base across a trunk move', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-review-failover-'))
    const caller = join(repo, '.claude', 'caller')
    const codexScript = join(repo, 'first-review.ts')
    const grokScript = join(repo, 'successor-review.ts')
    const firstReady = join(repo, 'first-review.ready')
    const trunkMoved = join(repo, 'trunk-moved.ready')
    const git = (cwd: string, ...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    const codex = AGENTS.codex!
    const grok = AGENTS.grok!
    const priorCodex = {
      bin: codex.bin, argv: codex.argv, stdin: codex.stdin,
      readsOut: codex.readsOut, parseReply: codex.parseReply,
    }
    const priorGrok = {
      bin: grok.bin, argv: grok.argv, stdin: grok.stdin,
      readsOut: grok.readsOut, parseReply: grok.parseReply,
    }
    const priorDepth = process.env.ORCH_DEPTH
    try {
      git(repo, 'init', '-b', 'main')
      git(repo, 'config', 'user.email', 'orch-test@example.invalid')
      git(repo, 'config', 'user.name', 'Orch Test')
      appendFileSync(join(repo, '.git', 'info', 'exclude'), 'first-review.ready\ntrunk-moved.ready\n')
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      git(repo, 'add', 'base.txt'); git(repo, 'commit', '-m', 'base')
      const originalBase = git(repo, 'rev-parse', 'HEAD')
      mkdirSync(dirname(caller), { recursive: true })
      git(repo, 'worktree', 'add', '-b', 'feature', caller, originalBase)
      writeFileSync(join(caller, 'change.ts'), 'carried review subject\n')
      upsertProject({ name: 'review-failover-project', path: repo })

      const empty = reviewReply(0) as any
      empty.provenance.files_covered = []
      empty.provenance.commands_run = []
      const clean = reviewReply(0) as any
      clean.provenance.files_covered = ['change.ts']
      clean.provenance.commands_run = ['git diff -- change.ts']
      writeFileSync(codexScript, [
        "import { existsSync, writeFileSync } from 'node:fs'",
        `writeFileSync(${JSON.stringify(firstReady)}, 'ready\\n')`,
        `while (!existsSync(${JSON.stringify(trunkMoved)})) await Bun.sleep(10)`,
        `console.log(${JSON.stringify(JSON.stringify(empty))})`,
      ].join('\n'))
      writeFileSync(grokScript, [
        "import { existsSync } from 'node:fs'",
        "if (!existsSync('change.ts')) process.exit(19)",
        `console.log(${JSON.stringify(JSON.stringify(clean))})`,
      ].join('\n'))
      codex.bin = process.execPath; codex.argv = () => [codexScript]
      codex.stdin = false; codex.readsOut = false; codex.parseReply = undefined
      grok.bin = process.execPath; grok.argv = () => [grokScript]
      grok.stdin = false; grok.readsOut = false; grok.parseReply = undefined
      process.env.ORCH_DEPTH = '0'

      const pending = runJob({
        job: 'review-lens', prompt: 'review the carried change', cwd: caller,
        repo: 'review-failover-project', agent: 'codex', lens: 'failover-base', carry: true,
      })
      for (let i = 0; i < 200 && !existsSync(firstReady); i++) await Bun.sleep(10)
      expect(existsSync(firstReady)).toBe(true)
      writeFileSync(join(repo, 'trunk.txt'), 'moved\n')
      git(repo, 'add', 'trunk.txt'); git(repo, 'commit', '-m', 'trunk moves')
      writeFileSync(trunkMoved, 'moved\n')
      const result = await pending
      expect(result.agent).toBe('grok')
      const rows = db().query(
        `SELECT id, agent, status, failure_kind, retry_of, base_commit
           FROM run WHERE repo='review-failover-project' ORDER BY id`,
      ).all() as {
        id: number; agent: string; status: string; failure_kind: string | null
        retry_of: number | null; base_commit: string
      }[]
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({
        agent: 'codex', status: 'failed', failure_kind: 'unevidenced', base_commit: originalBase,
      })
      expect(rows[1]).toMatchObject({
        agent: 'grok', status: 'ok', retry_of: rows[0]!.id, base_commit: originalBase,
      })
      expect(git(repo, 'rev-parse', 'main')).not.toBe(originalBase)
    } finally {
      codex.bin = priorCodex.bin; codex.argv = priorCodex.argv; codex.stdin = priorCodex.stdin
      codex.readsOut = priorCodex.readsOut; codex.parseReply = priorCodex.parseReply
      grok.bin = priorGrok.bin; grok.argv = priorGrok.argv; grok.stdin = priorGrok.stdin
      grok.readsOut = priorGrok.readsOut; grok.parseReply = priorGrok.parseReply
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      removeProject('review-failover-project')
      rmSync(repo, { recursive: true, force: true })
    }
  }, 15_000)

  test('a repository review failover bypasses a writing recipe that cannot recreate its base', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-review-failover-no-base-'))
    const caller = join(repo, '.claude', 'caller')
    const codexScript = join(repo, 'first-review.ts')
    const grokScript = join(repo, 'successor-review.ts')
    const projectScript = join(repo, 'project-worktree.ts')
    const firstReady = join(repo, 'first-review.ready')
    const releaseFirst = join(repo, 'release-first.ready')
    const projectInvoked = join(repo, 'project-worktree.invoked')
    const git = (cwd: string, ...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    const codex = AGENTS.codex!
    const grok = AGENTS.grok!
    const priorCodex = {
      bin: codex.bin, argv: codex.argv, stdin: codex.stdin,
      readsOut: codex.readsOut, parseReply: codex.parseReply,
    }
    const priorGrok = {
      bin: grok.bin, argv: grok.argv, stdin: grok.stdin,
      readsOut: grok.readsOut, parseReply: grok.parseReply,
    }
    const priorDepth = process.env.ORCH_DEPTH
    try {
      git(repo, 'init', '-b', 'main')
      git(repo, 'config', 'user.email', 'orch-test@example.invalid')
      git(repo, 'config', 'user.name', 'Orch Test')
      appendFileSync(
        join(repo, '.git', 'info', 'exclude'),
        'first-review.ready\nrelease-first.ready\nproject-worktree.invoked\n',
      )
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      git(repo, 'add', 'base.txt'); git(repo, 'commit', '-m', 'base')
      const originalBase = git(repo, 'rev-parse', 'HEAD')
      mkdirSync(dirname(caller), { recursive: true })
      git(repo, 'worktree', 'add', '-b', 'feature', caller, 'HEAD')
      writeFileSync(join(caller, 'change.ts'), 'carried review subject\n')
      upsertProject({ name: 'review-failover-no-base-project', path: repo })

      const empty = reviewReply(0) as any
      empty.provenance.files_covered = []
      empty.provenance.commands_run = []
      const clean = reviewReply(0) as any
      clean.provenance.files_covered = ['change.ts']
      clean.provenance.commands_run = ['git diff -- change.ts']
      writeFileSync(codexScript, [
        "import { existsSync, writeFileSync } from 'node:fs'",
        `writeFileSync(${JSON.stringify(firstReady)}, 'ready\\n')`,
        `while (!existsSync(${JSON.stringify(releaseFirst)})) await Bun.sleep(10)`,
        `console.log(${JSON.stringify(JSON.stringify(empty))})`,
      ].join('\n'))
      writeFileSync(grokScript, [
        "import { existsSync } from 'node:fs'",
        "if (!existsSync('change.ts')) process.exit(19)",
        `console.log(${JSON.stringify(JSON.stringify(clean))})`,
      ].join('\n'))
      writeFileSync(projectScript, [
        "import { writeFileSync } from 'node:fs'",
        `writeFileSync(${JSON.stringify(projectInvoked)}, 'invoked\\n')`,
      ].join('\n'))
      codex.bin = process.execPath; codex.argv = () => [codexScript]
      codex.stdin = false; codex.readsOut = false; codex.parseReply = undefined
      grok.bin = process.execPath; grok.argv = () => [grokScript]
      grok.stdin = false; grok.readsOut = false; grok.parseReply = undefined
      process.env.ORCH_DEPTH = '0'

      const pending = runJob({
        job: 'review-lens', prompt: 'review the carried change', cwd: caller,
        repo: 'review-failover-no-base-project', agent: 'codex', lens: 'failover-no-base', carry: true,
      })
      for (let i = 0; i < 200 && !existsSync(firstReady); i++) await Bun.sleep(10)
      expect(existsSync(firstReady)).toBe(true)
      upsertProject({
        name: 'review-failover-no-base-project', path: repo,
        settings: {
          worktree: {
            create: declaredCreate(process.execPath, [projectScript, '{branch}']),
            branch: 'task/{id}',
          },
        },
      })
      writeFileSync(releaseFirst, 'release\n')
      const result = await pending
      expect(result.agent).toBe('grok')
      expect(result.worktree?.source).toBe('git')
      expect(git(result.worktree!.path, 'rev-parse', 'HEAD')).toBe(originalBase)
      expect(Bun.spawnSync(['git', 'symbolic-ref', '-q', 'HEAD'], {
        cwd: result.worktree!.path, env: hermeticGitEnv(),
      }).exitCode).not.toBe(0)

      const rows = db().query(
        `SELECT id, agent, status, failure_kind, retry_of, base_commit, worktree_source
           FROM run WHERE repo='review-failover-no-base-project' ORDER BY id`,
      ).all() as {
        id: number; agent: string; status: string; failure_kind: string | null; retry_of: number | null
        base_commit: string; worktree_source: string | null
      }[]
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({
        agent: 'codex', status: 'failed', failure_kind: 'unevidenced',
        base_commit: originalBase, worktree_source: 'git',
      })
      expect(rows[1]).toMatchObject({
        agent: 'grok', status: 'ok', retry_of: rows[0]!.id,
        base_commit: originalBase, worktree_source: 'git',
      })
      expect(existsSync(projectInvoked)).toBe(false)
    } finally {
      if (!existsSync(releaseFirst)) writeFileSync(releaseFirst, 'release\n')
      codex.bin = priorCodex.bin; codex.argv = priorCodex.argv; codex.stdin = priorCodex.stdin
      codex.readsOut = priorCodex.readsOut; codex.parseReply = priorCodex.parseReply
      grok.bin = priorGrok.bin; grok.argv = priorGrok.argv; grok.stdin = priorGrok.stdin
      grok.readsOut = priorGrok.readsOut; grok.parseReply = priorGrok.parseReply
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      removeProject('review-failover-no-base-project')
      rmSync(repo, { recursive: true, force: true })
    }
  }, 15_000)

  test('prefer persists through automatic failover and the successor returns the answer', async () => {
    const binDir = join(dir, 'failover-bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\necho "HTTP 402: balance exhausted" >&2\nexit 1\n')
    writeFileSync(
      join(binDir, 'grok'),
      '#!/bin/sh\nprintf \'{"type":"result","result":"successor answer"}\\n\'\n',
    )
    chmodSync(join(binDir, 'codex'), 0o755)
    chmodSync(join(binDir, 'grok'), 0o755)
    const oldPath = process.env.PATH
    const oldDepth = process.env.ORCH_DEPTH
    process.env.PATH = `${binDir}:${oldPath ?? ''}`
    process.env.ORCH_DEPTH = '0'
    try {
      const result = await runJob({
        job: 'understand', prompt: 'the exact original prompt', agent: 'codex', cwd: dir,
        ownerSession: 'failover-owner', mcp: 'prefer',
      })
      expect(result.agent).toBe('grok')
      expect(result.output).toBe('successor answer')
      const rows = db().query(
        'SELECT id, agent, status, failure_kind, retry_of, session_id, mcp FROM run ORDER BY id',
      ).all() as {
        id: number; agent: string; status: string; failure_kind: string | null
        retry_of: number | null; session_id: string | null; mcp: number
      }[]
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ agent: 'codex', status: 'failed', failure_kind: 'quota' })
      expect(rows[1]).toMatchObject({
        agent: 'grok', status: 'ok', retry_of: rows[0]!.id, session_id: 'failover-owner',
      })
      expect(rows.map((row) => row.mcp)).toEqual([2, 2])

      const collected = orch('result', String(rows[0]!.id))
      expect(collected.code).toBe(0)
      expect(collected.out).toContain('successor answer')
      expect(collected.err).toContain('codex died (quota:')
      expect(collected.err).toContain('grok answered')
      expect(pendingForSession('failover-owner').map((row) => row.id)).toEqual([rows[1]!.id])
    } finally {
      process.env.PATH = oldPath
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
    }
  })

  test('explicit review failover keeps the original ref and resolved tip', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-review-failover-'))
    const binDir = join(repo, 'failover-bin')
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\necho "HTTP 402: balance exhausted" >&2\nexit 1\n')
    const review = reviewReply(0)
    review.provenance.files_covered.push('subject.txt')
    review.provenance.commands_run.push(
      'git diff main...feature/review-failover -- subject.txt',
    )
    const event = JSON.stringify({ type: 'result', result: JSON.stringify(review) })
    writeFileSync(join(binDir, 'grok'), `#!/bin/sh\nprintf '%s\\n' '${event}'\n`)
    chmodSync(join(binDir, 'codex'), 0o755)
    chmodSync(join(binDir, 'grok'), 0o755)
    const oldPath = process.env.PATH
    const oldDepth = process.env.ORCH_DEPTH
    process.env.PATH = `${binDir}:${oldPath ?? ''}`
    process.env.ORCH_DEPTH = '0'
    try {
      git('init', '-b', 'main')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'subject.txt'), 'trunk\n')
      git('add', 'subject.txt')
      git('commit', '-m', 'trunk')
      git('switch', '-c', 'feature/review-failover')
      writeFileSync(join(repo, 'subject.txt'), 'reviewed branch\n')
      git('add', 'subject.txt')
      git('commit', '-m', 'branch')
      const tip = git('rev-parse', 'HEAD^{commit}')
      const tree = git('rev-parse', 'HEAD^{tree}')
      git('switch', 'main')
      upsertProject({ name: 'review-failover-fixture', path: repo, settings: { trunk: 'main' } })

      const result = await runJob({
        job: 'review-lens', prompt: 'inspect the requested branch', cwd: repo,
        agent: 'codex', lens: 'failover-review', review: 'feature/review-failover',
      })
      const rows = db().query(
        `SELECT id, agent, retry_of, input_tree, head_commit, review_ref
           FROM run ORDER BY id`,
      ).all() as {
        id: number; agent: string; retry_of: number | null; input_tree: string | null
        head_commit: string | null; review_ref: string | null
      }[]
      expect(rows).toHaveLength(2)
      expect(rows[1]).toMatchObject({
        agent: 'grok', retry_of: rows[0]!.id, input_tree: tree,
        head_commit: tip, review_ref: 'feature/review-failover',
      })
      expect(git('-C', result.worktree!.path, 'rev-parse', 'HEAD')).toBe(tip)
    } finally {
      process.env.PATH = oldPath
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a vendor content refusal is recorded distinctly and fails over', async () => {
    const binDir = join(dir, 'content-refusal-bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'codex'), [
      '#!/bin/sh',
      'echo "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. To get authorized for security work, join the Trusted Access for Cyber program: https://chatgpt.com/cyber" >&2',
      'exit 1',
      '',
    ].join('\n'))
    writeFileSync(
      join(binDir, 'grok'),
      '#!/bin/sh\nprintf \'{"type":"result","result":"review completed"}\\n\'\n',
    )
    chmodSync(join(binDir, 'codex'), 0o755)
    chmodSync(join(binDir, 'grok'), 0o755)
    const oldPath = process.env.PATH
    const oldDepth = process.env.ORCH_DEPTH
    process.env.PATH = `${binDir}:${oldPath ?? ''}`
    process.env.ORCH_DEPTH = '0'
    try {
      const result = await runJob({
        job: 'understand', prompt: 'review the defensive guard', agent: 'codex', cwd: dir,
      })
      expect(result.agent).toBe('grok')
      expect(result.output).toBe('review completed')
      const rows = db().query(
        'SELECT id, agent, status, failure_kind, retry_of FROM run ORDER BY id',
      ).all() as {
        id: number; agent: string; status: string; failure_kind: string | null
        retry_of: number | null
      }[]
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({
        agent: 'codex', status: 'failed', failure_kind: 'content_refusal', retry_of: null,
      })
      expect(rows[1]).toMatchObject({
        agent: 'grok', status: 'ok', failure_kind: null, retry_of: rows[0]!.id,
      })

      const candidate = candidates('understand').find((item) => item.agent === 'codex')!
      expect(candidate.failures).toBe(0)
      expect(candidate.evidence).toBe(0)
      expect(candidate.cooling).toBeNull()
    } finally {
      process.env.PATH = oldPath
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
    }
  })

  test('runs, runs --json, and --follow report the same failover chain', () => {
    const binDir = join(dir, 'failover-surfaces-bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\necho "HTTP 402: balance exhausted" >&2\nexit 1\n')
    writeFileSync(
      join(binDir, 'grok'),
      '#!/bin/sh\nprintf \'{"type":"result","result":"shared surface answer"}\\n\'\n',
    )
    chmodSync(join(binDir, 'codex'), 0o755)
    chmodSync(join(binDir, 'grok'), 0o755)
    const oldPath = process.env.PATH
    process.env.PATH = `${binDir}:${oldPath ?? ''}`
    try {
      const followed = orch(
        'do', 'understand', 'report one chain everywhere', '--agent', 'codex', '--follow',
        '--key', 'DEV-133',
      )
      expect(followed.code).toBe(0)
      expect(followed.out).toContain('shared surface answer')

      const attempts = db().query(
        'SELECT id, agent, retry_of FROM run ORDER BY id',
      ).all() as { id: number; agent: string; retry_of: number | null }[]
      expect(attempts).toHaveLength(2)
      const [first, successor] = attempts as [typeof attempts[number], typeof attempts[number]]
      expect(successor.retry_of).toBe(first.id)
      db().query('UPDATE run SET vendor_tokens=?, vendor_cost_usd=? WHERE id=?')
        .run(111, 0.11, first.id)
      db().query('UPDATE run SET vendor_tokens=?, vendor_cost_usd=? WHERE id=?')
        .run(222, 0.22, successor.id)
      const rootOutput = join(dir, `failover-root-${first.id}.txt`)
      const successorOutput = join(dir, `failover-successor-${successor.id}.txt`)
      writeFileSync(rootOutput, 'x'.repeat(600))
      writeFileSync(successorOutput, 'x'.repeat(2048))
      db().query('UPDATE run SET latency_ms=?, probe=?, output_path=? WHERE id=?')
        .run(10_000, 0, rootOutput, first.id)
      db().query('UPDATE run SET latency_ms=?, probe=?, output_path=? WHERE id=?')
        .run(400_000, 1, successorOutput, successor.id)

      const human = orch('runs')
      expect(human.code).toBe(0)
      expect(human.out.match(new RegExp(`\\b${first.id}\\s+codex→grok`, 'g'))).toHaveLength(1)
      expect(human.out).not.toMatch(new RegExp(`\\b${successor.id}\\s+`))
      expect(human.out).not.toContain('thin:')

      const json = orch('runs', '--json')
      expect(json.code).toBe(0)
      const listed = json.out.trim().split('\n').map(runJson) as {
        id: number; agent: string; retry_of: number | null; failover_chain: string[]
        vendor_tokens: number; vendor_cost_usd: number; questions: unknown[]
      }[]
      expect(listed.map((row) => row.id)).toEqual([successor.id, first.id])
      expect(listed.map((row) => row.retry_of)).toEqual([first.id, null])
      expect(listed.map((row) => [row.vendor_tokens, row.vendor_cost_usd]))
        .toEqual([[222, 0.22], [111, 0.11]])
      expect(listed.every((row) =>
        JSON.stringify(row.failover_chain) === JSON.stringify(['codex', 'grok']),
      )).toBe(true)
      expect(listed.every((row) => Array.isArray(row.questions))).toBe(true)

      expect(followed.err).toContain(`run ${successor.id} · grok`)
      expect(followed.err).not.toContain(`run ${first.id} · grok`)
    } finally {
      process.env.PATH = oldPath
    }
  }, 20_000)

  test('runs --json publishes every question on the root, including child turns', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const child = addRun({
      agent: 'codex', job: 'implement', status: 'asking', parent: root, turn: 2,
    })
    db().query('INSERT INTO question (run_id, asked_at, question, answered_at) VALUES (?,?,?,?)')
      .run(root, '2026-09-04T10:00:00.000Z', 'root q', '2026-09-04T10:05:00.000Z')
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(child, '2026-09-04T10:10:00.000Z', 'child q')

    const json = orch('runs', '--json', '--id', String(root))
    expect(json.code).toBe(0)
    const [row] = json.out.trim().split('\n').map(runJson) as {
      id: number
      questions: { id: number; run_id: number; asked_at: string; answered_at: string | null }[]
    }[]
    expect(row!.id).toBe(root)
    expect(row!.questions).toEqual([
      expect.objectContaining({
        run_id: root, asked_at: '2026-09-04T10:00:00.000Z', answered_at: '2026-09-04T10:05:00.000Z',
      }),
      expect.objectContaining({
        run_id: child, asked_at: '2026-09-04T10:10:00.000Z', answered_at: null,
      }),
    ])
    expect(row!.questions.every((q) =>
      Object.keys(q).sort().join() === 'answered_at,asked_at,id,run_id',
    )).toBe(true)
  })

  test('--no-failover holds and records a clear terminal explanation', async () => {
    const binDir = join(dir, 'no-failover-bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\necho "usage limit reached" >&2\nexit 1\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    const oldPath = process.env.PATH
    const oldDepth = process.env.ORCH_DEPTH
    process.env.PATH = `${binDir}:${oldPath ?? ''}`
    process.env.ORCH_DEPTH = '0'
    try {
      await expect(runJob({
        job: 'understand', prompt: 'do not retry this', agent: 'codex', cwd: dir,
        noFailover: true,
      })).rejects.toThrow(/usage limit reached/)
      const row = db().query(
        'SELECT no_failover, failure_kind, error FROM run ORDER BY id DESC LIMIT 1',
      ).get() as { no_failover: number; failure_kind: string; error: string }
      expect(row.no_failover).toBe(1)
      expect(row.failure_kind).toBe('quota')
      expect(row.error).toContain('Failover refused: disabled by --no-failover')
      expect(row.error).toContain('worktree ')
      expect(row.error).not.toContain('(none — read-only job)')
    } finally {
      process.env.PATH = oldPath
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
    }
  })

  test('three quota deaths spend the attempt budget and name every agent', async () => {
    const binDir = join(dir, 'budget-bin')
    mkdirSync(binDir, { recursive: true })
    for (const bin of ['codex', 'agy']) {
      writeFileSync(join(binDir, bin), '#!/bin/sh\necho "HTTP 402: no balance" >&2\nexit 1\n')
      chmodSync(join(binDir, bin), 0o755)
    }
    writeFileSync(
      join(binDir, 'grok'),
      '#!/bin/sh\nprintf \'{"type":"result","errors":["HTTP 402: no balance"]}\\n\'\n',
    )
    chmodSync(join(binDir, 'grok'), 0o755)
    const oldPath = process.env.PATH
    const oldDepth = process.env.ORCH_DEPTH
    process.env.PATH = `${binDir}:${oldPath ?? ''}`
    process.env.ORCH_DEPTH = '0'
    try {
      await expect(runJob({
        job: 'review-lens-inline', prompt: 'bounded', agent: 'codex', cwd: dir, lens: 'bounded',
      })).rejects.toThrow()
      const rows = db().query(
        'SELECT id, agent, retry_of, error FROM run ORDER BY id',
      ).all() as { id: number; agent: string; retry_of: number | null; error: string }[]
      expect(rows).toHaveLength(3)
      expect(rows.map((row) => row.agent)).toEqual(['codex', 'agy', 'grok'])
      expect(rows[2]!.error).toContain('the 3-attempt budget was spent')
      expect(rows[2]!.error).toContain('tried codex, agy, grok')
    } finally {
      process.env.PATH = oldPath
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
    }
  })

  test('a writing run with edits names and preserves its tree instead of failing over', () => {
    const reason = writingFailoverRefusal(true, {
      files: ['partial.ts'], diff: 'diff', insertions: 1, deletions: 0,
      since: 'base', trunk: 'main', trunkConfigured: true,
    }, '/tmp/orch-42')
    expect(reason).toBe(
      'writing run has 1 changed file(s); preserving worktree /tmp/orch-42 ' +
      'so two agents never share one diff',
    )
    expect(writingFailoverRefusal(true, {
      files: [], diff: '', insertions: 0, deletions: 0,
      since: 'base', trunk: 'main', trunkConfigured: true,
    }, '/tmp/orch-42')).toBeNull()
    expect(writingFailoverRefusal(true, null, '/tmp/orch-42'))
      .toContain('worktree diff could not be read')
  })

  test('a resumed turn can also fail over forward without confusing the two axes', () => {
    const root = addRun({ agent: 'codex', job: 'understand', status: 'failed' })
    const turn = addRun({
      agent: 'codex', job: 'understand', status: 'failed', kind: 'quota', parent: root, turn: 2,
    })
    db().query("UPDATE run SET error='HTTP 402' WHERE id IN (?,?)").run(root, turn)
    const successor = addRun({ agent: 'grok', job: 'understand', session: 's' })
    db().query('UPDATE run SET retry_of=?, automatic_failover=1 WHERE id=?').run(turn, successor)
    const output = join(dir, `combined-axes-${successor}.txt`)
    writeFileSync(output, 'answer after resumed failure')
    db().query('UPDATE run SET output_path=? WHERE id=?').run(output, successor)

    const waited = orch('wait', String(root))
    expect(waited.code).toBe(0)
    expect(waited.out).toContain(`${root}\tok`)
    expect(waited.out).toContain('codex died (quota: HTTP 402); grok answered')
    const result = orch('result', String(root))
    expect(result.out).toContain('answer after resumed failure')
    expect(result.err).toContain('grok answered')
    const listed = orch('runs')
    expect(listed.out.match(new RegExp(`\\b${root}\\s+codex→grok`, 'g'))).toHaveLength(1)
    expect(listed.out).not.toMatch(new RegExp(`\\b${successor}\\s+`))
  }, 20_000)

  test('a deliberate retry remains separate from an automatic failover chain', () => {
    const first = addRun({ agent: 'codex', job: 'understand', status: 'failed', kind: 'quota' })
    const retry = addRun({ agent: 'grok', job: 'understand' })
    db().query('UPDATE run SET retry_of=? WHERE id=?').run(first, retry)
    const original = orch('result', String(first))
    expect(original.code).toBe(1)
    expect(original.err).not.toContain('failover:')
    const retried = orch('result', String(retry))
    expect(retried.code).toBe(0)
    expect(retried.err).not.toContain('failover:')
    const listed = orch('runs')
    expect(listed.out).toMatch(new RegExp(`\\b${first}\\s+codex\\s+`))
    expect(listed.out).toMatch(new RegExp(`\\b${retry}\\s+grok\\s+`))
  }, 20_000)
})

describe('a destroyed output is not evidence about the agent', () => {
  test('score --void retains the run, output, and score but removes routing evidence', () => {
    const CLI = new URL('cli.ts', import.meta.url).pathname
    const outputPath = join(dir, 'voided-output.txt')
    writeFileSync(outputPath, 'the retained answer')
    const id = addRun({ agent: 'codex', job: 'review-lens' })
    db().query('UPDATE run SET output_path=?, session_id=? WHERE id=?')
      .run(outputPath, 'orch-test-session', id)
    score(id, 'full', 'right')

    const p = Bun.spawnSync([process.execPath, CLI, 'score', String(id), '--void'], {
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(p.exitCode).toBe(0)
    expect(new TextDecoder().decode(p.stdout)).toContain('retained run and output')
    expect(readFileSync(outputPath, 'utf8')).toBe('the retained answer')
    expect(db().query('SELECT evidence_excluded FROM run WHERE id=?').get(id))
      .toEqual({ evidence_excluded: 'voided with orch score --void' })
    expect(db().query('SELECT COUNT(*) n FROM score WHERE run_id=?').get(id)).toEqual({ n: 1 })
    expect(db().query(
      'SELECT run_id, root_id, action, actor_session FROM run_mutation_audit WHERE run_id=?',
    ).get(id)).toEqual({
      run_id: id, root_id: id, action: 'void', actor_session: 'orch-test-session',
    })
    expect(candidates('review-lens').find((c) => c.agent === 'codex')!.evidence).toBe(0)
  })

  test('score --void refuses a foreign owner and permits an attributed unowned run', () => {
    const CLI = new URL('cli.ts', import.meta.url).pathname
    const owned = addRun({ agent: 'codex', job: 'review-lens' })
    db().query('UPDATE run SET session_id=? WHERE id=?').run('owner-session', owned)
    const foreign = Bun.spawnSync([process.execPath, CLI, 'score', String(owned), '--void'], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'foreign-session' }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(foreign.exitCode).toBe(1)
    expect(db().query('SELECT evidence_excluded FROM run WHERE id=?').get(owned))
      .toEqual({ evidence_excluded: null })

    const unowned = addRun({ agent: 'codex', job: 'review-lens' })
    const allowed = Bun.spawnSync([process.execPath, CLI, 'score', String(unowned), '--void'], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'acting-session' }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(allowed.exitCode).toBe(0)
    expect(db().query(
      'SELECT action, actor_session, reason FROM run_mutation_audit WHERE run_id=? ORDER BY rowid',
    ).all(unowned)).toEqual([
      { action: 'adopt', actor_session: 'acting-session', reason: 'before void' },
      { action: 'void', actor_session: 'acting-session', reason: null },
    ])
    expect(db().query('SELECT session_id FROM run WHERE id=?').get(unowned))
      .toEqual({ session_id: 'acting-session' })
  })

  test('a scored collision is kept as a verdict and dropped from routing', () => {
    // The score stays: a person did judge what they were shown. It simply
    // stops counting, because what they were shown was another run's work.
    const kept = addRun({ agent: 'codex', job: 'review-lens' })
    score(kept, 'full', 'right')
    const a = addRun({ agent: 'codex', job: 'review-lens' })
    const b = addRun({ agent: 'codex', job: 'review-lens' })
    score(a, 'none')
    score(b, 'none')
    db().query("UPDATE run SET evidence_excluded='shared an output file' WHERE id IN (?,?)")
      .run(a, b)

    const c = candidates('review-lens').find((x) => x.agent === 'codex')!
    expect(c.scored).toBe(1)
    expect(c.evidence).toBe(1)
    expect(c.score).toBe(weigh('full', 'right'))
    const n = (db().query('SELECT COUNT(*) n FROM score').get() as { n: number }).n
    expect(n).toBe(3)
  })

  test('the backfill stamps every member of a colliding group, and no unique path', () => {
    const shared = join(dir, 'collided.txt')
    const unique = join(dir, 'alone.txt')
    const a = addRun({ agent: 'codex', job: 'review-lens' })
    const b = addRun({ agent: 'codex', job: 'review-lens' })
    const c = addRun({ agent: 'codex', job: 'review-lens' })
    db().query('UPDATE run SET output_path=? WHERE id IN (?,?)').run(shared, a, b)
    db().query('UPDATE run SET output_path=? WHERE id=?').run(unique, c)
    expect(excludeSharedOutputRuns(db())).toBe(2)
    const rows = db().query(
      'SELECT id, evidence_excluded AS why FROM run WHERE id IN (?,?,?) ORDER BY id',
    ).all(a, b, c) as { id: number; why: string | null }[]
    expect(rows.find((r) => r.id === a)!.why).toBe(SHARED_OUTPUT_REASON)
    expect(rows.find((r) => r.id === b)!.why).toBe(SHARED_OUTPUT_REASON)
    expect(rows.find((r) => r.id === c)!.why).toBeNull()
  })

  test('a reason already written is left alone', () => {
    const shared = join(dir, 'already.txt')
    const a = addRun({ agent: 'codex', job: 'review-lens' })
    const b = addRun({ agent: 'codex', job: 'review-lens' })
    db().query('UPDATE run SET output_path=? WHERE id IN (?,?)').run(shared, a, b)
    db().query("UPDATE run SET evidence_excluded='already set' WHERE id=?").run(a)
    expect(excludeSharedOutputRuns(db())).toBe(1)
    const why = db().query(
      'SELECT evidence_excluded AS why FROM run WHERE id=?',
    ).get(a) as { why: string }
    expect(why.why).toBe('already set')
  })

  test('orch result says so on the record a person would score from', () => {
    const CLI = new URL('cli.ts', import.meta.url).pathname
    const id = addRun({ agent: 'codex', job: 'review-lens' })
    db().query("UPDATE run SET evidence_excluded='shared an output file' WHERE id=?").run(id)
    const p = Bun.spawnSync([process.execPath, CLI, 'result', String(id)], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
      stdout: 'pipe', stderr: 'pipe',
    })
    const err = new TextDecoder().decode(p.stderr)
    expect(p.exitCode).toBe(0)
    expect(err).toContain('not routing evidence: shared an output file')
  })
})

describe('grok reply parsing', () => {
  test('every agent explicitly declares its observed output-ceiling stop reason', () => {
    expect(Object.fromEntries(Object.entries(AGENTS).map(([name, agent]) =>
      [name, agent.outputCeilingStopReason]))).toEqual({
      codex: null,
      agy: null,
      'qwen-local': null,
      grok: 'max_tokens',
    })
  })

  test('takes only the terminal result from a tool-using message stream', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: "I'll fetch it first." }], stop_reason: 'tool_use' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '## Finding' }], stop_reason: 'end_turn' },
      }),
      JSON.stringify({
        type: 'result', subtype: 'success', result: '## Finding', total_cost_usd: 0.25,
        usage: { input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 5 },
      }),
    ].join('\n')
    expect(AGENTS.grok!.parseReply!(stdout)).toEqual({
      text: '## Finding', tokens: 35, costUsd: 0.25, stopReason: 'end_turn',
    })
  })

  test('uses the clean stream for plain and schema-constrained replies', () => {
    const out = join(dir, 'grok-out.txt')
    expect(AGENTS.grok!.argv({ prompt: 'x', out, model: 'grok-4.6' }))
      .toContain('streaming-messages-json')
    const schema = join(dir, 'grok-schema.json')
    writeFileSync(schema, '{}')
    const args = AGENTS.grok!.argv({ prompt: 'x', out, model: 'grok-4.6', schema })
    expect(args).toContain('streaming-messages-json')
    expect(args.indexOf('--json-schema')).toBeLessThan(args.indexOf('--output-format'))
  })

  test('records a cancelled result event as a failed run with its error', async () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'trimmed' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Working.' }], stop_reason: 'tool_use' },
      }),
      JSON.stringify({
        type: 'result', subtype: 'error_during_execution', errors: ['cancelled'],
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    ].join('\n')
    const script = join(dir, 'fake-grok-cancelled.sh')
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' '${stdout}'\n`)
    chmodSync(script, 0o755)
    const grok = AGENTS.grok!
    const previous = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      grok.bin = script
      const reserved = addRun({ agent: '(pending)', job: 'file-question', status: 'running' })
      await expect(run({ job: 'file-question', prompt: 'hello', cwd: dir, agent: 'grok', reserveId: reserved }))
        .rejects.toThrow('cancelled')
      const failed = db().query(
        'SELECT status, failure_kind, error, output_path, output_bytes FROM run WHERE id=?',
      ).get(reserved) as {
        status: string; failure_kind: string; error: string
        output_path: string; output_bytes: number
      }
      expect(failed.status).toBe('failed')
      expect(failed.failure_kind).toBe('other')
      expect(failed.error).toBe('cancelled')
      expect(existsSync(failed.output_path)).toBe(true)
      expect(readFileSync(failed.output_path, 'utf8')).toBe(stdout + '\n')
      expect(failed.output_bytes).toBe(new TextEncoder().encode(stdout + '\n').byteLength)

      writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' '${stdout}'\nkill -TERM $$\n`)
      const interrupted = addRun({ agent: '(pending)', job: 'file-question', status: 'running' })
      await expect(run({ job: 'file-question', prompt: 'hello', cwd: dir, agent: 'grok', reserveId: interrupted }))
        .rejects.toThrow('cancelled')
      expect(db().query('SELECT status, failure_kind, error FROM run WHERE id=?').get(interrupted))
        .toEqual({ status: 'failed', failure_kind: 'interrupted', error: 'cancelled' })
    } finally {
      grok.bin = previous
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('retains and recovers a transcript when an empty result hits the output ceiling', async () => {
    const visible = `DROP-ME-${'x'.repeat(40 * 1024)}-RECOVERED-END`
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'truncated' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'thinking', text: visible }], stop_reason: 'max_tokens' },
      }),
      JSON.stringify({
        type: 'result', subtype: 'error_during_execution', result: '', stop_reason: 'max_tokens',
        errors: ['response truncated by max_tokens'], usage: { input_tokens: 10, output_tokens: 2 },
      }),
    ].join('\n') + '\n'
    const script = join(dir, 'fake-grok-truncated.ts')
    writeFileSync(script, `process.stdout.write(${JSON.stringify(stdout)})\n`)
    const grok = AGENTS.grok!
    const previous = {
      bin: grok.bin, argv: grok.argv, stdin: grok.stdin,
      readsOut: grok.readsOut, parseReply: grok.parseReply,
    }
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      grok.bin = process.execPath
      grok.argv = () => [script]
      grok.stdin = false
      grok.readsOut = false
      const reserved = addRun({ agent: '(pending)', job: 'file-question', status: 'running' })
      await expect(run({
        job: 'file-question', prompt: 'recover this report', cwd: dir,
        agent: 'grok', reserveId: reserved,
      })).rejects.toThrow('response truncated at output ceiling (max_tokens)')

      const failed = db().query(
        'SELECT status, failure_kind, output_path, output_bytes FROM run WHERE id=?',
      ).get(reserved) as {
        status: string; failure_kind: string; output_path: string; output_bytes: number
      }
      expect(failed.status).toBe('failed')
      expect(failed.failure_kind).toBe('truncated')
      expect(readFileSync(failed.output_path, 'utf8')).toBe(stdout)
      expect(failed.output_bytes).toBe(Buffer.byteLength(stdout))
      expect(NOT_EVIDENCE).toContain('truncated')
      expect(candidates('file-question').find((candidate) => candidate.agent === 'grok')!.evidence)
        .toBe(0)

      const result = Bun.spawnSync([
        process.execPath, new URL('cli.ts', import.meta.url).pathname,
        'result', String(reserved),
      ], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      const recovered = result.stdout.toString()
      expect(result.exitCode).toBe(1)
      expect(recovered).toStartWith(
        'TRUNCATED at the output ceiling — this is the transcript, not a result\n',
      )
      expect(recovered).toContain('RECOVERED-END')
      expect(recovered).not.toContain('DROP-ME')
    } finally {
      grok.bin = previous.bin
      grok.argv = previous.argv
      grok.stdin = previous.stdin
      grok.readsOut = previous.readsOut
      grok.parseReply = previous.parseReply
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(script, { force: true })
    }
  })

  test('a terminal result without errors or final text is a parse failure', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'trimmed' }),
      JSON.stringify({ type: 'result', subtype: 'success', errors: [] }),
    ].join('\n')
    expect(AGENTS.grok!.parseReply!(stdout)).toEqual({
      text: '', tokens: null, costUsd: null, error: 'grok result contained no final text',
    })
  })
})
