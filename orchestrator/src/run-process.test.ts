import { describe, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENTS, addRun, db, dir, runJob, upsertProject } from '../test/fixture.ts'
import { errorTail, verifiedProcessTree } from './run-process.ts'

describe('what survives of a failure', () => {
  const codexish = (promptChars: number) =>
    'OpenAI Codex v0.151.0\n--------\nmodel: gpt-5.6-sol\nsandbox: read-only\n--------\n' +
    'x'.repeat(promptChars) +
    '\nERROR: the thing that actually broke'

  test('the error at the end is kept', () => {
    expect(errorTail(codexish(50_000))).toContain('the thing that actually broke')
  })

  test('and the banner at the start is kept too', () => {
    const out = errorTail(codexish(50_000))
    expect(out).toContain('OpenAI Codex v0.151.0')
    expect(out).toContain('model: gpt-5.6-sol')
  })

  test('the echoed prompt in the middle is what gets dropped', () => {
    const out = errorTail(codexish(50_000))
    expect(out).toContain('characters omitted')
    expect(out.length).toBeLessThan(2200)
  })

  test('a short error is stored whole, untouched', () => {
    expect(errorTail('exit 143, empty output')).toBe('exit 143, empty output')
  })
})

test('process reaping selects the whole verified tree youngest-first and rejects pid reuse', () => {
  const rows = [
    { pid: 10, ppid: 1, pgid: 10, command: 'bun /repo/orchestrator/src/exec.ts 44 prompt implement' },
    { pid: 11, ppid: 10, pgid: 10, command: 'vendor' },
    { pid: 12, ppid: 11, pgid: 10, command: 'gateway' },
    { pid: 99, ppid: 1, pgid: 99, command: 'bun run dev' },
  ]
  expect(verifiedProcessTree(rows, 44, 10)).toEqual([12, 11, 10])
  expect(verifiedProcessTree(rows, 44, 99)).toEqual([])
  expect(verifiedProcessTree(rows, 45, 10)).toEqual([])
})

describe('childEnv allowlists the vendor CLI environment', () => {
  test('a spawned agent does not inherit unrelated credentials', async () => {
    const script = join(dir, 'dump-env-dev89.ts')
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.env))\n')
    const agent = AGENTS.codex!
    const origBin = agent.bin
    const origArgv = agent.argv
    agent.bin = process.execPath
    agent.argv = () => [script]
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'

    const planted = [
      'UNRELATED_SECRET_DEV89', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_SESSION_ID',
      'EXAMPLE_MCP_TOKEN', 'LC_ALL', 'XDG_CONFIG_HOME', 'OPENAI_API_KEY',
      'COLORTERM',
    ] as const
    const prior: Record<string, string | undefined> = {}
    for (const key of planted) prior[key] = process.env[key]
    process.env.UNRELATED_SECRET_DEV89 = 'should-not-leak'
    process.env.ANTHROPIC_API_KEY = 'should-not-leak'
    process.env.CLAUDE_CODE_SESSION_ID = 'should-not-leak'
    process.env.EXAMPLE_MCP_TOKEN = 'should-not-leak'
    process.env.LC_ALL = 'C'
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-dev89'
    process.env.OPENAI_API_KEY = 'vendor-ok'
    process.env.COLORTERM = 'truecolor'
    upsertProject({ name: 'env-allow', path: dir, settings: { envPrefix: 'EXAMPLE' } })

    try {
      const result = await runJob({
        job: 'file-question', prompt: 'dump env', cwd: dir, agent: 'codex',
      })
      const child = JSON.parse(result.output) as Record<string, string>
      expect(child.UNRELATED_SECRET_DEV89).toBeUndefined()
      expect(child.ANTHROPIC_API_KEY).toBeUndefined()
      expect(child.CLAUDE_CODE_SESSION_ID).toBeUndefined()
      expect(child.EXAMPLE_MCP_TOKEN).toBeUndefined()
      expect(child.COLORTERM).toBeUndefined()
      expect(child.LC_ALL).toBe('C')
      expect(child.XDG_CONFIG_HOME).toBe('/tmp/xdg-dev89')
      expect(child.OPENAI_API_KEY).toBe('vendor-ok')
      expect(child.PATH).toBe(process.env.PATH as string)
      expect(child.HOME).toBe(process.env.HOME as string)
      expect(child.ORCH_DB).toBe(process.env.ORCH_DB as string)
      expect(child.ORCH_DEPTH).toBe('1')
      expect(child.ORCH_RUN_ID).toBe(String(result.id))
      expect(child.ORCH_RUN_TOKEN).toBeTruthy()
      expect(child.ORCH_RUN_TOKEN).toBe(
        (db().query('SELECT run_token FROM run WHERE id=?').get(result.id) as { run_token: string }).run_token,
      )
      for (const key of ['USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'SSH_AUTH_SOCK'] as const) {
        const parent = process.env[key]
        if (parent !== undefined) expect(child[key]).toBe(parent)
        else expect(child[key]).toBeUndefined()
      }
    } finally {
      agent.bin = origBin
      agent.argv = origArgv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      for (const key of planted) {
        if (prior[key] === undefined) delete process.env[key]
        else process.env[key] = prior[key]
      }
    }
  })

  test('a no-repo worker is not handed the orchestrator database', async () => {
    const script = join(dir, 'dump-no-repo-env-dev363.ts')
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.env))\n')
    const agent = AGENTS.codex!
    const original = { bin: agent.bin, argv: agent.argv }
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    agent.bin = process.execPath
    agent.argv = () => [script]
    try {
      const result = await runJob({
        job: 'summarize', prompt: 'dump env', cwd: dir, agent: 'codex', noFailover: true,
      })
      expect((JSON.parse(result.output) as Record<string, string>).ORCH_DB).toBeUndefined()
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(script, { force: true })
    }
  })

  test('a resumed spawn hands the child the turn id and the token minted for that turn', async () => {
    const script = join(dir, 'dump-env-resume-dev289.ts')
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.env))\n')
    const agent = AGENTS.codex!
    const origBin = agent.bin
    const origResume = agent.resumeArgv
    agent.bin = process.execPath
    agent.resumeArgv = () => [script]
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const rootPrompt = join(dir, 'resume-env-root.prompt.txt')
    writeFileSync(rootPrompt, 'original spec')
    try {
      const parent = addRun({ agent: 'codex', job: 'file-question', status: 'asking' })
      db().query('UPDATE run SET vendor_session=?, prompt_path=?, run_token=? WHERE id=?')
        .run('root-session', rootPrompt, 'root-token', parent)
      const result = await runJob({
        job: 'file-question', prompt: 'continue', cwd: dir,
        resume: {
          parent, agent: 'codex', session: 'root-session', turn: 2,
          sessionId: 'orch-test-session', worktree: null,
        },
      })
      const child = JSON.parse(result.output) as Record<string, string>
      const row = db().query('SELECT parent_run_id, turn, run_token FROM run WHERE id=?')
        .get(result.id) as { parent_run_id: number; turn: number; run_token: string }
      expect(result.id).not.toBe(parent)
      expect(row).toEqual({ parent_run_id: parent, turn: 2, run_token: child.ORCH_RUN_TOKEN })
      expect(child.ORCH_RUN_ID).toBe(String(result.id))
      expect(child.ORCH_RUN_TOKEN).toBeTruthy()
      expect(child.ORCH_RUN_TOKEN).not.toBe('root-token')
    } finally {
      agent.bin = origBin
      agent.resumeArgv = origResume
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(script, { force: true })
      rmSync(rootPrompt, { force: true })
    }
  })
})
