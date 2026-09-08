import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync, chmodSync, lstatSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { AGENTS, VERIFY_CLAIM_SCHEMA, addRun, assertGrokTrustEligible, canonSourceFor, canonSourceInstruction, db, declaredCreate, dir, grokMcpConnection, hermeticGitCommand, hermeticGitEnv, mcpRequestFromStored, preflightMcp, reviewReply, runJob, upsertProject, validateCliArgs } from '../test/fixture.ts'

const GROK_REVIEW_EVENT = JSON.stringify({
  type: 'result', subtype: 'success', result: JSON.stringify(reviewReply(1)),
})
const CODEX_REVIEW_EVENT = JSON.stringify({
  type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(reviewReply(1)) },
})

describe('review-lens MCP provenance', () => {
  let priorGrokHome: string | undefined
  let grokHome: string
  beforeEach(() => {
    writeFileSync(join(dir, '.mcp.json'), '{}\n')
    priorGrokHome = process.env.GROK_HOME
    grokHome = mkdtempSync(join(tmpdir(), 'orch-grok-home-'))
    process.env.GROK_HOME = grokHome
  })
  afterEach(() => {
    rmSync(join(dir, '.mcp.json'), { force: true })
    rmSync(grokHome, { recursive: true, force: true })
    if (priorGrokHome === undefined) delete process.env.GROK_HOME
    else process.env.GROK_HOME = priorGrokHome
  })

  test('the MCP flag accepts required and prefer modes only', () => {
    expect(() => validateCliArgs(['do', 'review-lens', 'review', '--mcp'])).not.toThrow()
    expect(() => validateCliArgs(['do', 'review-lens', 'review', '--mcp=prefer'])).not.toThrow()
    expect(() => validateCliArgs(['do', 'review-lens', 'review', '--mcp=optional']))
      .toThrow('--mcp=prefer')
  })

  test.each([
    [0, null, undefined],
    [1, null, 'require'],
    [2, null, 'prefer'],
    [1, 'mirror: legacy attach failed', 'prefer'],
  ] as const)('reads stored MCP request %i with error %s as %s', (stored, error, expected) => {
    expect(mcpRequestFromStored(stored, error)).toBe(expected)
  })

  const mcpRepo = (withConfig: boolean) => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-mcp-cwd-')))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    git('init', '-b', 'main')
    git('config', 'user.email', 'orch-test@example.invalid')
    git('config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'tracked.txt'), 'base\n')
    git('add', 'tracked.txt'); git('commit', '-m', 'base')
    if (withConfig) writeFileSync(join(repo, '.mcp.json'), '{}\n')
    upsertProject({ name: 'fixture-project', path: repo, settings: {} })
    return repo
  }

  const codexReview = async (
    repo: string, tools: string[], mcp: boolean,
  ): Promise<{ id: number; status: string; error: string | null }> => {
    const script = join(dir, `codex-provenance-${randomUUID()}.ts`)
    const baseReply = reviewReply(1)
    const reply = { ...baseReply, provenance: { ...baseReply.provenance, mcp_tools: tools } }
    writeFileSync(script, `process.stdout.write(${JSON.stringify(JSON.stringify(reply))})\n`)
    const agent = AGENTS.codex!
    const original = { bin: agent.bin, argv: agent.argv, readsOut: agent.readsOut, stdin: agent.stdin }
    agent.bin = process.execPath
    agent.argv = () => [script]
    agent.readsOut = false
    agent.stdin = false
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      try {
        const result = await runJob({ job: 'review-lens', prompt: 'review', cwd: repo,
          agent: 'codex', mcp, lens: 'provenance-shapes', keepTree: true, noFailover: true })
        return { id: result.id, status: result.status, error: null }
      } catch (error) {
        const runId = (error as { runId?: number }).runId
        if (!runId) throw error
        return db().query('SELECT id, status, error FROM run WHERE id=?').get(runId) as
          { id: number; status: string; error: string }
      }
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.readsOut = original.readsOut
      agent.stdin = original.stdin
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(script, { force: true })
    }
  }

  test('provenance rejects only another registered project MCP prefix', async () => {
    const repo = mcpRepo(true)
    upsertProject({ name: 'other-project', path: join(repo, 'not-this-project'),
      settings: { mcpServer: 'other-server' } })
    try {
      for (const tool of ['get_doc', 'mcp__fixture-project__get_doc', 'orch-ask.get_doc']) {
        const result = await codexReview(repo, [tool], true)
        expect(result.status, tool).toBe('ok')
      }
      expect((await codexReview(repo, ['fixture-project.get_doc'], false)).status).toBe('ok')
      const wrong = await codexReview(repo, ['other-server.get_doc'], true)
      expect(wrong.status).toBe('failed')
      expect(wrong.error).toContain('wrong project: provenance names other-server.get_doc')
      const wrongWithoutMcp = await codexReview(repo, ['other-server.get_doc'], false)
      expect(wrongWithoutMcp.status).toBe('failed')
      expect(wrongWithoutMcp.error).toContain('wrong project: provenance names other-server.get_doc')
      expect(wrongWithoutMcp.error).toContain('fixture-project')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('silent provenance requires requested MCP degradation', async () => {
    const repo = mcpRepo(false)
    try {
      const plain = await codexReview(repo, [], false)
      const requested = await codexReview(repo, [], true)
      expect(db().query('SELECT provenance_status FROM run WHERE id=?').get(plain.id))
        .toEqual({ provenance_status: null })
      expect(db().query('SELECT provenance_status FROM run WHERE id=?').get(requested.id))
        .toEqual({ provenance_status: 'silent' })
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('grants only an orch-cut tree and names the invariant for a caller checkout', () => {
    expect(() => assertGrokTrustEligible('/tmp/orch-tree', {
      worktree: '/tmp/orch-tree', worktree_source: 'git',
    })).not.toThrow()
    expect(() => assertGrokTrustEligible('/tmp/caller-checkout', {
      worktree: '/tmp/orch-tree', worktree_source: 'git',
    })).toThrow(
      'refusing Grok trust for /tmp/caller-checkout: trust is granted only to trees orch cut; ' +
      'removed tree paths never recur',
    )
  })

  test('grants trust to an orch-created no-repo isolate but not its caller checkout', () => {
    const runs = '/tmp/orch-runs'
    const isolate = '/tmp/orch-runs/isolates/42'
    const recorded = {
      id: 42, cwd: isolate, worktree: null, worktree_source: null,
    }
    expect(() => assertGrokTrustEligible(isolate, recorded, runs)).not.toThrow()
    expect(() => assertGrokTrustEligible('/tmp/caller-checkout', recorded, runs)).toThrow(
      'refusing Grok trust for /tmp/caller-checkout',
    )
  })

  test('passes scoped trust to doctor and spawn and records every new heading verbatim', async () => {
    const repo = mcpRepo(true)
    const script = join(dir, 'fake-grok-trust-round-trip.sh')
    writeFileSync(script, `#!/bin/sh
if case " $* " in *" mcp doctor "*) true ;; *) false ;; esac; then
  printf '%s' "$*" > "$GROK_HOME/doctor-argv"
  printf '%s\n' '[folders."/tmp/first observed"]' 'trusted = true' "[folders.'/tmp/second-observed']" 'trusted = true' >> "$GROK_HOME/trusted_folders.toml"
  printf '%s' '{"servers":[{"name":"fixture-project","healthy":true,"checks":[]}]}'
else
  printf '%s' "$*" > "$GROK_HOME/spawn-argv"
  printf '%s\n' '${GROK_REVIEW_EVENT}'
fi
`)
    chmodSync(script, 0o755)
    writeFileSync(
      join(grokHome, 'trusted_folders.toml'),
      '[folders."/tmp/already-present"]\ntrusted = true\n',
    )
    const agent = AGENTS.grok!
    const originalBin = agent.bin
    agent.bin = script
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      const result = await runJob({
        job: 'review-lens', prompt: 'review this', cwd: repo,
        agent: 'grok', mcp: 'require', lens: 'trust', keepTree: true,
      })
      const row = db().query(
        'SELECT mcp_trust_granted, mcp_trust_path FROM run WHERE id=?',
      ).get(result.id) as { mcp_trust_granted: number; mcp_trust_path: string }
      expect(row.mcp_trust_granted).toBe(1)
      expect(JSON.parse(row.mcp_trust_path)).toEqual([
        '[folders."/tmp/first observed"]', "[folders.'/tmp/second-observed']",
      ])
      const invocations = ['doctor-argv', 'spawn-argv']
        .map((file) => readFileSync(join(grokHome, file), 'utf8'))
      for (const invocation of invocations) {
        expect(invocation).toContain(`--cwd ${result.worktree!.path} --trust`)
      }
      expect(invocations[0]).toContain('mcp doctor fixture-project --json')
      expect(invocations[1]).toContain(' -p ')
    } finally {
      agent.bin = originalBin
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('records a trust attempt before a doctor spawn throws', async () => {
    const repo = mcpRepo(true)
    const agent = AGENTS.grok!
    const originalBin = agent.bin
    const script = join(dir, 'grok-removed-before-doctor')
    writeFileSync(script, '#!/bin/sh\nprintf "grok 1.0.13\\n"\n')
    chmodSync(script, 0o755)
    const create = join(dir, 'remove-grok-while-cutting.sh')
    writeFileSync(create, `#!/bin/sh
${hermeticGitCommand} worktree add --detach "$1" "$2" >/dev/null
rm ${JSON.stringify(script)}
echo "$1"
`)
    chmodSync(create, 0o755)
    upsertProject({
      name: 'fixture-project', path: repo,
      settings: {
        worktree: {
          branch: 'orch/{id}',
          readonly_create: declaredCreate(create, ['{path}', '{base}']),
        },
      },
    })
    agent.bin = script
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const before = (db().query('SELECT MAX(id) id FROM run').get() as { id: number | null }).id ?? 0
    try {
      await expect(runJob({
        job: 'review-lens', prompt: 'review this', cwd: repo,
        agent: 'grok', mcp: 'require', lens: 'trust-throws',
      })).rejects.toThrow()
      expect(db().query(
        'SELECT mcp_trust_granted, mcp_trust_path FROM run WHERE id > ? ORDER BY id LIMIT 1',
      ).get(before)).toEqual({ mcp_trust_granted: 1, mcp_trust_path: null })
    } finally {
      agent.bin = originalBin
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a caller-checkout doctor never receives trust', () => {
    const script = join(dir, 'fake-grok-caller-doctor.sh')
    const argv = join(grokHome, 'caller-argv')
    writeFileSync(script, `#!/bin/sh
printf '%s' "$*" > "$GROK_HOME/caller-argv"
printf '%s' '{"servers":[{"name":"fixture-project","healthy":true,"checks":[]}]}'
`)
    chmodSync(script, 0o755)
    expect(grokMcpConnection(script, dir, 'fixture-project', {
      PATH: process.env.PATH ?? '', GROK_HOME: grokHome,
    }).connected).toBe(true)
    expect(readFileSync(argv, 'utf8')).not.toContain('--trust')
  })

  test('installed Grok 1.0.13 currently keys a linked worktree grant by its main repository', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-installed-grok-trust-')))
    const repo = join(root, 'repo')
    const tree = join(root, 'linked-tree')
    mkdirSync(repo)
    const git = (...args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    try {
      expect(git('init', '-b', 'main').exitCode).toBe(0)
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'base'), '')
      git('add', 'base')
      expect(git('commit', '-m', 'base').exitCode).toBe(0)
      expect(git('worktree', 'add', '--detach', tree, 'HEAD').exitCode).toBe(0)
      const grant = Bun.spawnSync(['grok', '--cwd', tree, '--trust', 'mcp', 'list', '--json'], {
        env: { ...process.env, GROK_HOME: grokHome }, stdout: 'pipe', stderr: 'pipe',
      })
      expect(grant.exitCode).toBe(0)
      expect(readFileSync(join(grokHome, 'trusted_folders.toml'), 'utf8').split(/\r?\n/)
        .filter((line) => line.startsWith('[folders.'))).toEqual([
          `[folders.${JSON.stringify(repo)}]`,
        ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('provisions cwd-discovered MCP with a relative symlink and reports it in the output header', async () => {
    const repo = mcpRepo(true)
    const script = join(dir, 'fake-grok-cwd-mcp.sh')
    writeFileSync(script, `#!/bin/sh
if case " $* " in *" mcp doctor "*) true ;; *) false ;; esac; then
  test -L .mcp.json || exit 97
  printf '%s' '{"servers":[{"name":"fixture-project","healthy":true,"checks":[]}]}'
else
  printf '%s\n' '${GROK_REVIEW_EVENT}'
fi
`)
    chmodSync(script, 0o755)
    const agent = AGENTS.grok!
    const original = { bin: agent.bin, argv: agent.argv }
    agent.bin = script
    agent.argv = () => []
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      const result = await runJob({
        job: 'review-lens', prompt: 'review this', cwd: repo,
        agent: 'grok', mcp: 'require', lens: 'mcp-cwd', keepTree: true,
      })
      expect(result.status).toBe('ok')
      expect(result.output).toContain('MCP preflight: linked .mcp.json -> ../../../.mcp.json')
      expect(lstatSync(join(result.worktree!.path, '.mcp.json')).isSymbolicLink()).toBe(true)
      expect(realpathSync(join(result.worktree!.path, '.mcp.json'))).toBe(join(repo, '.mcp.json'))
      const measured = db().query('SELECT input_tree, changed_paths FROM run WHERE id=?')
        .get(result.id) as { input_tree: string; changed_paths: string }
      const treeFiles = Bun.spawnSync(['git', 'ls-tree', '-r', '--name-only', measured.input_tree], {
        cwd: result.worktree!.path, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      }).stdout.toString().trim().split('\n')
      expect(treeFiles).not.toContain('.mcp.json')
      expect(JSON.parse(measured.changed_paths ?? '[]')).not.toContain('.mcp.json')
    } finally {
      agent.bin = original.bin; agent.argv = original.argv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('keeps and measures a real MCP config that replaces the provisioned link', async () => {
    const repo = mcpRepo(true)
    const script = join(dir, 'fake-grok-replaces-mcp-link.sh')
    writeFileSync(script, `#!/bin/sh
if case " $* " in *" mcp doctor "*) true ;; *) false ;; esac; then
  test -L .mcp.json || exit 97
  printf '%s' '{"servers":[{"name":"fixture-project","healthy":true,"checks":[]}]}'
else
  rm .mcp.json
  printf '%s\n' '{"worker":true}' > .mcp.json
  printf '%s\n' '${GROK_REVIEW_EVENT}'
fi
`)
    chmodSync(script, 0o755)
    const agent = AGENTS.grok!
    const original = { bin: agent.bin, argv: agent.argv }
    agent.bin = script; agent.argv = () => []
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      const result = await runJob({
        job: 'review-lens', prompt: 'review this', cwd: repo,
        agent: 'grok', mcp: 'require', lens: 'mcp-cwd', keepTree: true,
      })
      expect(result.status).toBe('ok')
      expect(lstatSync(join(result.worktree!.path, '.mcp.json')).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(result.worktree!.path, '.mcp.json'), 'utf8'))
        .toBe('{"worker":true}\n')
      expect(result.changes!.files).toContain('.mcp.json')
    } finally {
      agent.bin = original.bin; agent.argv = original.argv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('uses a real MCP config supplied by the project worktree recipe without a checkout copy', async () => {
    const repo = mcpRepo(false)
    writeFileSync(join(repo, '.gitignore'), '.mcp.json\n')
    Bun.spawnSync(['git', 'add', '.gitignore'], { cwd: repo, env: hermeticGitEnv() })
    Bun.spawnSync(['git', 'commit', '-m', 'ignore recipe config'], { cwd: repo, env: hermeticGitEnv() })
    const recipeCreate = join(dir, 'create-recipe-mcp.sh')
    writeFileSync(recipeCreate, `#!/bin/sh
${hermeticGitCommand} worktree add --detach "$1" "$2" >/dev/null
printf '{}\\n' > "$1/.mcp.json"
echo "$1"
`)
    chmodSync(recipeCreate, 0o755)
    upsertProject({
      name: 'fixture-project', path: repo,
      settings: {
        worktree: {
          branch: 'orch/{id}',
          readonly_create: declaredCreate(recipeCreate, ['{path}', '{base}']),
        },
      },
    })
    const script = join(dir, 'fake-grok-recipe-mcp.sh')
    writeFileSync(script, `#!/bin/sh
if case " $* " in *" mcp doctor "*) true ;; *) false ;; esac; then
  test -f .mcp.json && test ! -L .mcp.json || exit 97
  printf '%s' '{"servers":[{"name":"fixture-project","healthy":true,"checks":[]}]}'
else
  printf '%s\n' '${GROK_REVIEW_EVENT}'
fi
`)
    chmodSync(script, 0o755)
    const agent = AGENTS.grok!
    const original = { bin: agent.bin, argv: agent.argv }
    agent.bin = script; agent.argv = () => []
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      const result = await runJob({
        job: 'review-lens', prompt: 'review this', cwd: repo,
        agent: 'grok', mcp: 'require', lens: 'mcp-cwd', keepTree: true,
      })
      expect(result.status).toBe('ok')
      expect(lstatSync(join(result.worktree!.path, '.mcp.json')).isSymbolicLink()).toBe(false)
    } finally {
      agent.bin = original.bin; agent.argv = original.argv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('measures a real MCP config carried from the caller worktree', async () => {
    const repo = mcpRepo(false)
    const caller = join(repo, '.claude', 'worktrees', 'caller-mcp')
    mkdirSync(dirname(caller), { recursive: true })
    const added = Bun.spawnSync(['git', 'worktree', 'add', '-b', 'caller-mcp', caller, 'HEAD'], {
      cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (added.exitCode !== 0) throw new Error(added.stderr.toString())
    writeFileSync(join(caller, '.mcp.json'), '{}\n')
    const script = join(dir, 'fake-grok-carried-mcp.sh')
    writeFileSync(script, `#!/bin/sh
if case " $* " in *" mcp doctor "*) true ;; *) false ;; esac; then
  test -f .mcp.json && test ! -L .mcp.json || exit 97
  printf '%s' '{"servers":[{"name":"fixture-project","healthy":true,"checks":[]}]}'
else
  printf '%s\n' '${GROK_REVIEW_EVENT}'
fi
`)
    chmodSync(script, 0o755)
    const agent = AGENTS.grok!
    const original = { bin: agent.bin, argv: agent.argv }
    agent.bin = script; agent.argv = () => []
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      const result = await runJob({
        job: 'review-lens', prompt: 'review this', cwd: caller, carry: true,
        agent: 'grok', mcp: 'require', lens: 'mcp-cwd', keepTree: true,
      })
      expect(result.status).toBe('ok')
      expect(lstatSync(join(result.worktree!.path, '.mcp.json')).isSymbolicLink()).toBe(false)
      expect(result.changes!.files).toContain('.mcp.json')
      const inputTree = (db().query('SELECT input_tree FROM run WHERE id=?').get(result.id) as {
        input_tree: string
      }).input_tree
      const treeFiles = Bun.spawnSync(['git', 'ls-tree', '-r', '--name-only', inputTree], {
        cwd: result.worktree!.path, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      }).stdout.toString().trim().split('\n')
      expect(treeFiles).toContain('.mcp.json')
    } finally {
      agent.bin = original.bin; agent.argv = original.argv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('refuses cwd-discovered required MCP before agent spawn when the checkout has no config', async () => {
    const repo = mcpRepo(false)
    const agent = AGENTS.grok!
    const original = { bin: agent.bin, argv: agent.argv }
    let spawned = false
    agent.bin = join(dir, 'must-not-spawn-grok.sh')
    writeFileSync(agent.bin, '#!/bin/sh\nexit 99\n'); chmodSync(agent.bin, 0o755)
    agent.argv = () => { spawned = true; return [] }
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      await expect(runJob({
        job: 'review-lens', prompt: 'review this', cwd: repo,
        agent: 'grok', mcp: 'require', lens: 'mcp-cwd', keepTree: true,
      })).rejects.toThrow('missing .mcp.json')
      expect(spawned).toBe(false)
    } finally {
      agent.bin = original.bin; agent.argv = original.argv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('prefer mode runs on the mirror and records and discloses the attachment failure', async () => {
    const repo = mcpRepo(true)
    const script = join(dir, 'fake-grok-prefer-mirror.sh')
    writeFileSync(script, `#!/bin/sh
if case " $* " in *" mcp doctor "*) true ;; *) false ;; esac; then
  printf '%s' '{"servers":[{"name":"fixture-project","healthy":false,"checks":[{"label":"unavailable","passed":false,"detail":"server down"}]}]}'
else
  printf '%s\n' '${GROK_REVIEW_EVENT}'
fi
`)
    chmodSync(script, 0o755)
    const agent = AGENTS.grok!
    const original = { bin: agent.bin, argv: agent.argv }
    agent.bin = script; agent.argv = () => []
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      const result = await runJob({
        job: 'review-lens', prompt: 'review this', cwd: repo,
        agent: 'grok', mcp: 'prefer', lens: 'mcp-cwd', keepTree: true,
      })
      expect(result.status).toBe('ok')
      expect(db().query(
        'SELECT mcp_connected, mcp_error FROM run WHERE id=?',
      ).get(result.id)).toEqual({
        mcp_connected: 0, mcp_error: 'mirror: unavailable: server down',
      })
      const collected = Bun.spawnSync([
        process.execPath, new URL('cli.ts', import.meta.url).pathname, 'result', String(result.id),
      ], { env: { ...process.env, ORCH_DB: process.env.ORCH_DB! }, stdout: 'pipe', stderr: 'pipe' })
      expect(collected.stderr.toString()).toContain('MIRROR — not the live database')
    } finally {
      agent.bin = original.bin; agent.argv = original.argv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('continue without parent output inherits prefer, re-probes, and keeps MIRROR explicit', async () => {
    const repo = mcpRepo(true)
    const binDir = mkdtempSync(join(tmpdir(), 'orch-grok-prefer-continue-'))
    const script = join(binDir, 'grok')
    writeFileSync(script, `#!/bin/sh
if case " $* " in *" mcp doctor "*) true ;; *) false ;; esac; then
  printf '%s' '{"servers":[{"name":"fixture-project","healthy":false,"checks":[{"label":"unavailable","passed":false,"detail":"server down"}]}]}'
else
  printf '%s\n' '${GROK_REVIEW_EVENT}'
fi
`)
    chmodSync(script, 0o755)
    const agent = AGENTS.grok!
    const original = { bin: agent.bin, argv: agent.argv }
    agent.bin = script; agent.argv = () => []
    const priorDepth = process.env.ORCH_DEPTH
    const priorSession = process.env.CLAUDE_CODE_SESSION_ID
    process.env.ORCH_DEPTH = '0'
    process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
    try {
      const root = await runJob({
        job: 'review-lens', prompt: 'review this', cwd: repo,
        agent: 'grok', mcp: 'prefer', lens: 'mcp-cwd', keepTree: true,
      })
      expect((db().query('SELECT mcp FROM run WHERE id=?').get(root.id) as { mcp: number }).mcp)
        .toBe(2)
      db().query('DELETE FROM review WHERE id=(SELECT review_id FROM review_lens WHERE run_id=?)')
        .run(root.id)
      unlinkSync(root.outPath)
      expect(existsSync(root.outPath)).toBe(false)
      agent.bin = original.bin; agent.argv = original.argv
      const continued = Bun.spawnSync([
        process.execPath, new URL('cli.ts', import.meta.url).pathname,
        'continue', String(root.id), 'review once more',
      ], {
        cwd: repo,
        env: {
          ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: 'orch-test-session',
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(continued.exitCode, `${continued.stdout.toString()}\n${continued.stderr.toString()}`).toBe(0)
      const childId = Number(continued.stdout.toString().replace(/\u001B\[[0-9;]*m/g, '').trim().split('\n')[0])
      expect(childId).toBeGreaterThan(0)
      const invoke = (...args: string[]) => Bun.spawnSync([
        process.execPath, new URL('cli.ts', import.meta.url).pathname, ...args,
      ], {
        cwd: repo,
        env: {
          ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: 'orch-test-session',
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      const waited = invoke('wait', String(childId), '--timeout', '15')
      if (waited.exitCode !== 0) {
        throw new Error(`stdout: ${waited.stdout.toString()}\nstderr: ${waited.stderr.toString()}`)
      }
      expect(waited.exitCode).toBe(0)
      expect(db().query(
        'SELECT parent_run_id, mcp, mcp_connected, mcp_error, input_tree FROM run WHERE id=?',
      ).get(childId)).toEqual({
        parent_run_id: root.id, mcp: 2, mcp_connected: 0,
        mcp_error: 'mirror: unavailable: server down',
        input_tree: expect.any(String),
      })
      const child = db().query('SELECT input_tree FROM run WHERE id=?').get(childId) as
        { input_tree: string }
      const childTree = Bun.spawnSync(['git', 'ls-tree', '-r', '--name-only', child.input_tree], {
        cwd: root.worktree!.path, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      }).stdout.toString().trim().split('\n')
      expect(childTree).not.toContain('.mcp.json')
      const collected = invoke('result', String(childId))
      expect(collected.stderr.toString()).toContain('MIRROR — not the live database')
      const bound = db().query('SELECT prompt_path FROM run WHERE id=?').get(childId) as
        { prompt_path: string }
      expect(readFileSync(bound.prompt_path.replace(/\.prompt\.txt$/, '.bound.txt'), 'utf8'))
        .toContain(canonSourceInstruction('mirror'))
    } finally {
      agent.bin = original.bin; agent.argv = original.argv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = priorSession
      rmSync(binDir, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('preflightMcp defers cwd-discovered attachment until the worker tree exists', () => {
    const cwd = dir
    upsertProject({ name: 'fixture-project', path: cwd, settings: {} })
    const grok = AGENTS.grok!
    const originalBin = grok.bin
    grok.bin = join(dir, 'fake-grok-preflight-doctor.sh')
    writeFileSync(grok.bin, `#!/bin/sh
printf '%s' '{"servers":[{"name":"fixture-project","healthy":false,"checks":[{"label":"unavailable","passed":false,"detail":"server down"}]}]}'
`)
    chmodSync(grok.bin, 0o755)
    try {
      expect(() => preflightMcp({
        mcp: true, cwd, job: 'review-lens', prompt: 'review this', agent: 'codex',
      })).not.toThrow()
      expect(() => preflightMcp({
        mcp: true, cwd, job: 'review-lens', prompt: 'review this', agent: 'grok',
      })).not.toThrow()
      expect(() => preflightMcp({
        mcp: false, cwd, job: 'review-lens', prompt: 'review this', agent: 'grok',
      })).not.toThrow()
    } finally {
      grok.bin = originalBin
    }
  })

  test('orch do defers a no-repo Grok MCP doctor to its isolate', () => {
    const cwd = realpathSync(dir)
    upsertProject({ name: 'fixture-project', path: cwd, settings: {} })
    const binDir = join(dir, 'no-repo-production-preflight-bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'grok'), `#!/bin/sh
if case " $* " in *" mcp doctor "*) true ;; *) false ;; esac; then
  printf '%s' '{"servers":[{"name":"fixture-project","healthy":false,"checks":[{"label":"folder untrusted","passed":false,"detail":"repo-local server not started"}]}]}'
  exit 0
fi
exit 99
`)
    chmodSync(join(binDir, 'grok'), 0o755)
    const CLI = new URL('cli.ts', import.meta.url).pathname
    const result = Bun.spawnSync([
      process.execPath, CLI, 'do', 'mcp-query', 'query the server', '--mcp', '--agent', 'grok',
    ], {
      cwd,
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session',
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const id = Number(result.stdout.toString().trim())
    expect(id).toBeGreaterThan(0)
    expect(db().query('SELECT job FROM run WHERE id=?').get(id)).toEqual({ job: 'mcp-query' })
  })

  test('preflightMcp dispatches from a register-shaped legacy row with declared MCP settings', () => {
    const cwd = dir
    upsertProject({
      name: 'legacy-mcp-project', path: cwd,
      settings: {
        worktree: { create: 'scripts/worktree create "{branch}"' } as any,
        mcpServer: 'legacy-mcp', mcp: { probe_tool: 'task.list' },
      },
    })
    expect(() => preflightMcp({
      mcp: true, cwd, job: 'mcp-query', prompt: 'read the task', agent: 'codex',
    })).not.toThrow()
  })

  test('preflightMcp leaves cwd-discovered config decisions until the worker tree exists', () => {
    const cwd = dir
    upsertProject({ name: 'fixture-project', path: cwd, settings: { mcpServer: 'orch' } })
    const grok = AGENTS.grok!
    const originalBin = grok.bin
    grok.bin = join(dir, 'fake-grok-configured-server-doctor.sh')
    writeFileSync(grok.bin, `#!/bin/sh
printf '%s' '{"servers":[{"name":"orch","healthy":false,"checks":[{"label":"unavailable","passed":false,"detail":"server down"}]}]}'
`)
    chmodSync(grok.bin, 0o755)
    try {
      expect(() => preflightMcp({
        mcp: true, cwd, job: 'review-lens', prompt: 'review this', agent: 'grok',
      })).not.toThrow()
      rmSync(join(cwd, '.mcp.json'), { force: true })
      expect(() => preflightMcp({
        mcp: true, cwd, job: 'review-lens', prompt: 'review this', agent: 'grok',
      })).not.toThrow()
    } finally {
      grok.bin = originalBin
    }
  })

  test('reads Grok doctor as the same-named project connection', () => {
    const doctor = join(dir, 'fake-grok-mcp-doctor.sh')
    writeFileSync(doctor, `#!/bin/sh
printf '%s' '{"servers":[{"name":"starship","healthy":false,"checks":[{"label":"folder untrusted","passed":false,"detail":"repo-local server not started","hint":"re-run with --trust"}]}]}'
`)
    chmodSync(doctor, 0o755)
    expect(grokMcpConnection(doctor, dir, 'starship', { PATH: process.env.PATH ?? '' }))
      .toEqual({
        server: 'starship', connected: false,
        error: 'folder untrusted: repo-local server not started: re-run with --trust',
        namesSeen: ['starship'],
      })
  })

  test('a missing server names the ones doctor did report', () => {
    const doctor = join(dir, 'fake-grok-mcp-available.sh')
    writeFileSync(doctor, `#!/bin/sh
printf '%s' '{"servers":[{"name":"orch","healthy":true,"checks":[]},{"name":"user-scope","healthy":true,"checks":[]}]}'
`)
    chmodSync(doctor, 0o755)
    const result = grokMcpConnection(doctor, dir, 'starship', { PATH: process.env.PATH ?? '' })
    expect(result.connected).toBe(false)
    expect(result.error).toContain("MCP server 'starship' was not reported. Available: orch, user-scope")
    expect(result.error).toContain('"name":"orch"')
  })

  test('refuses a grok lens before agent spawn and records the worker-tree preflight failure', async () => {
    const script = join(dir, 'fake-grok-lens.sh')
    writeFileSync(script, `#!/bin/sh
if case " $* " in *" mcp doctor "*) true ;; *) false ;; esac; then
  printf '%s' '{"servers":[{"name":"fixture-project","healthy":false,"checks":[{"label":"folder untrusted","passed":false,"detail":"repo-local server not started","hint":"re-run with --trust"}]}]}'
else
  echo should-not-launch >&2
  exit 99
fi
`)
    chmodSync(script, 0o755)
    const agent = AGENTS.grok!
    const originalBin = agent.bin
    const originalArgv = agent.argv
    let sent = ''
    agent.bin = script
    agent.argv = ({ prompt }) => {
      sent = prompt
      return []
    }
    const cwd = dir
    upsertProject({ name: 'fixture-project', path: cwd, settings: {} })
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n
    try {
      await expect(runJob({
        job: 'review-lens', prompt: 'review this', cwd, agent: 'grok', mcp: true, lens: 'mcp',
      })).rejects.toThrow('Grok remained untrusted after scoped trust')
      expect(sent).toBe('')
      expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before + 1)
      expect(db().query('SELECT status, failure_kind FROM run ORDER BY id DESC LIMIT 1').get())
        .toEqual({ status: 'failed', failure_kind: 'harness' })
    } finally {
      agent.bin = originalBin
      agent.argv = originalArgv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('a connected lens receives live-database provenance in its assembled prompt', async () => {
    const script = join(dir, 'fake-grok-connected-lens.sh')
    writeFileSync(script, `#!/bin/sh
if case " $* " in *" mcp doctor "*) true ;; *) false ;; esac; then
  printf '%s' '{"servers":[{"name":"orch","healthy":true,"checks":[]}]}'
else
  printf '%s\n' '{"type":"system","subtype":"init"}'
  printf '%s\n' '${GROK_REVIEW_EVENT}'
fi
`)
    chmodSync(script, 0o755)
    const agent = AGENTS.grok!
    const originalBin = agent.bin
    const originalArgv = agent.argv
    let sent = ''
    agent.bin = script
    agent.argv = ({ prompt }) => {
      sent = prompt
      return []
    }
    const cwd = dir
    upsertProject({ name: 'fixture-project', path: cwd, settings: { mcpServer: 'orch' } })
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      const result = await runJob({
        job: 'review-lens', prompt: 'review this', cwd, agent: 'grok', mcp: true, lens: 'mcp',
      })
      expect(sent).toContain(canonSourceInstruction('live database'))
      expect(db().query(
        'SELECT mcp_server, mcp_connected FROM run WHERE id=?',
      ).get(result.id)).toEqual({
        mcp_server: 'orch', mcp_connected: 1,
      })
    } finally {
      agent.bin = originalBin
      agent.argv = originalArgv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('prefer binds mirror provenance once after a wrong-project worker-tree probe', async () => {
    const repo = mcpRepo(false)
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({
      mcpServers: { unrelated: { command: '/bin/false' } },
    }))
    const agent = AGENTS.codex!
    const original = { bin: agent.bin, argv: agent.argv, readsOut: agent.readsOut }
    const script = join(dir, 'fake-codex-wrong-project-prefer.sh')
    writeFileSync(script, `#!/bin/sh
printf '%s\n' '${CODEX_REVIEW_EVENT}'
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}'
`)
    chmodSync(script, 0o755)
    let sent = ''
    agent.bin = script
    agent.readsOut = false
    agent.argv = ({ prompt }) => { sent = prompt; return [] }
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      const result = await runJob({
        job: 'review-lens', prompt: 'review this', cwd: repo, carry: true,
        agent: 'codex', mcp: 'prefer', lens: 'mcp-worker-tree', keepTree: true,
      })
      expect(result.status).toBe('ok')
      expect(sent.match(/Canon source provenance:/g)).toHaveLength(1)
      expect(sent).toContain(canonSourceInstruction('mirror'))
      const row = db().query(
        'SELECT mcp_error, prompt_path, prompt_sha, prompt_bytes FROM run WHERE id=?',
      ).get(result.id) as {
        mcp_error: string; prompt_path: string; prompt_sha: string; prompt_bytes: number
      }
      expect(row.mcp_error.match(/mirror:/g)).toHaveLength(1)
      const bound = readFileSync(row.prompt_path.replace(/\.prompt\.txt$/, '.bound.txt'), 'utf8')
      expect(bound).toBe(sent)
      expect(row.prompt_bytes).toBe(Buffer.byteLength(bound))
      expect(row.prompt_sha).toBe(createHash('sha256').update(bound).digest('hex').slice(0, 16))
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.readsOut = original.readsOut
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a user-scope required server is refused only when doctor does not report it', async () => {
    const script = join(dir, 'DEV-372-user-scope-doctor.sh')
    writeFileSync(script, `#!/bin/sh
if case " $* " in *" mcp doctor "*) true ;; *) false ;; esac; then
  printf '%s' '{"servers":[{"name":"starship","healthy":true,"checks":[]},{"name":"stopal","healthy":true,"checks":[]},{"name":"alephbeis","healthy":true,"checks":[]},{"name":"youtrack-starship","healthy":true,"checks":[]},{"name":"youtrack-alephbeis","healthy":true,"checks":[]}]}'
else
  printf started > "${join(dir, 'DEV-372-user-scope-started')}"
fi
`)
    chmodSync(script, 0o755)
    const agent = AGENTS.grok!
    const originalBin = agent.bin
    const cwd = dir
    upsertProject({ name: 'fixture-project', path: cwd, settings: { mcpServer: 'orch' } })
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    agent.bin = script
    let runId: number | null = null
    try {
      try {
        await runJob({
          job: 'review-lens', prompt: 'review this', cwd, agent: 'grok', mcp: true, lens: 'mcp',
        })
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(runId).not.toBeNull()
      const row = db().query('SELECT mcp_error FROM run WHERE id=?').get(runId!) as { mcp_error: string }
      expect(row.mcp_error).toContain("MCP server 'orch' was not reported")
      expect(row.mcp_error).not.toContain('wrong project:')
      expect(existsSync(join(dir, 'DEV-372-user-scope-started'))).toBe(false)
    } finally {
      agent.bin = originalBin
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(join(dir, 'DEV-372-user-scope-started'), { force: true })
    }
  })

  test('a lens without --mcp receives unknown provenance and does not run the MCP doctor', async () => {
    const script = join(dir, 'fake-grok-no-mcp-lens.sh')
    writeFileSync(script, `#!/bin/sh
if case " $* " in *" mcp doctor "*) true ;; *) false ;; esac; then
  exit 99
fi
printf '%s\n' '{"type":"system","subtype":"init"}'
  printf '%s\n' '${GROK_REVIEW_EVENT}'
`)
    chmodSync(script, 0o755)
    const agent = AGENTS.grok!
    const originalBin = agent.bin
    const originalArgv = agent.argv
    let sent = ''
    agent.bin = script
    agent.argv = ({ prompt }) => {
      sent = prompt
      return []
    }
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      const result = await runJob({
        job: 'review-lens', prompt: 'review this', cwd: dir, agent: 'grok', mcp: false, lens: 'mcp',
      })
      expect(result.status).toBe('ok')
      expect(sent).toContain(canonSourceInstruction('unknown'))
      expect(db().query(
        'SELECT mcp, mcp_server, mcp_connected, mcp_error FROM run WHERE id=?',
      ).get(result.id)).toEqual({
        mcp: 0, mcp_server: null, mcp_connected: null, mcp_error: null,
      })
    } finally {
      agent.bin = originalBin
      agent.argv = originalArgv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('orch result exposes degradation and the explicit trust command', () => {
    const id = addRun({ agent: 'grok', job: 'review-lens' })
    db().query(
      `UPDATE run SET cwd=?, mcp=1, mcp_server='starship', mcp_connected=0,
                      mcp_error='folder untrusted: repo-local server not started' WHERE id=?`,
    ).run('/tmp/a lens tree', id)
    const CLI = new URL('cli.ts', import.meta.url).pathname
    const result = Bun.spawnSync([process.execPath, CLI, 'result', String(id)], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB! }, stdout: 'pipe', stderr: 'pipe',
    })
    const stderr = result.stderr.toString()
    expect(result.exitCode).toBe(0)
    expect(stderr).toContain('mcp:       starship NOT CONNECTED')
    expect(stderr).toContain("trust:     grok --cwd '/tmp/a lens tree' --trust")
  })

  test('orch result names an unverified attach distinctly from a confirmed one', () => {
    const unverified = addRun({ agent: 'codex', job: 'review-lens' })
    db().query(
      `UPDATE run SET mcp=1, mcp_server='fixture-project', mcp_connected=NULL,
                      mcp_error='codex does not expose an MCP connection diagnostic' WHERE id=?`,
    ).run(unverified)
    const confirmed = addRun({ agent: 'grok', job: 'review-lens' })
    db().query(
      `UPDATE run SET mcp=1, mcp_server='fixture-project', mcp_connected=1 WHERE id=?`,
    ).run(confirmed)
    const CLI = new URL('cli.ts', import.meta.url).pathname
    const env = { ...process.env, ORCH_DB: process.env.ORCH_DB! }
    const unknown = Bun.spawnSync([process.execPath, CLI, 'result', String(unverified)], {
      env, stdout: 'pipe', stderr: 'pipe',
    })
    const known = Bun.spawnSync([process.execPath, CLI, 'result', String(confirmed)], {
      env, stdout: 'pipe', stderr: 'pipe',
    })
    expect(unknown.stderr.toString()).toContain('mcp:       fixture-project UNVERIFIED')
    expect(unknown.stderr.toString()).not.toContain('connected')
    expect(known.stderr.toString()).toContain('mcp:       fixture-project connected')
    expect(known.stderr.toString()).not.toContain('UNVERIFIED')
  })

  test('a codex lens receives unknown provenance when its MCP attach cannot be diagnosed', async () => {
    const grok = AGENTS.grok!
    const codex = AGENTS.codex!
    const grokBin = grok.bin
    const grokArgv = grok.argv
    const codexBin = codex.bin
    const codexArgv = codex.argv
    const codexReadsOut = codex.readsOut
    grok.bin = join(dir, 'fake-grok-red-doctor.sh')
    writeFileSync(grok.bin, `#!/bin/sh
printf '%s' '{"servers":[{"name":"fixture-project","healthy":false,"checks":[{"label":"folder untrusted","passed":false,"detail":"repo-local server not started"}]}]}'
exit 0
`)
    chmodSync(grok.bin, 0o755)
    grok.argv = () => {
      throw new Error('grok must not launch')
    }
    const script = join(dir, 'fake-codex-unverified-lens.sh')
    writeFileSync(script, `#!/bin/sh
printf '%s\n' '${CODEX_REVIEW_EVENT}'
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}'
`)
    chmodSync(script, 0o755)
    let sent = ''
    codex.bin = script
    codex.readsOut = false
    codex.argv = ({ prompt }) => {
      sent = prompt
      return []
    }
    const cwd = dir
    upsertProject({ name: 'fixture-project', path: cwd, settings: {} })
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      const result = await runJob({
        job: 'review-lens', prompt: 'review this', cwd, agent: 'codex', mcp: true, lens: 'probe',
      })
      expect(result.status).toBe('ok')
      expect(sent).toContain(canonSourceInstruction('unknown'))
      expect(db().query(
        'SELECT mcp, mcp_server, mcp_connected, mcp_error FROM run WHERE id=?',
      ).get(result.id)).toEqual({
        mcp: 1, mcp_server: 'fixture-project', mcp_connected: null,
        mcp_error: 'codex does not expose an MCP connection diagnostic',
      })
    } finally {
      grok.bin = grokBin
      grok.argv = grokArgv
      codex.bin = codexBin
      codex.argv = codexArgv
      codex.readsOut = codexReadsOut
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('maps all recorded connection states without flattening unknown', () => {
    expect(canonSourceFor(true, { server: 'fixture-project', connected: true, error: null }, true))
      .toBe('live database')
    expect(canonSourceFor(true, { server: 'fixture-project', connected: false, error: 'down' }, true))
      .toBe('mirror')
    expect(canonSourceFor(true, { server: 'fixture-project', connected: null, error: 'no diagnostic' }, true))
      .toBe('unknown')
  })

  test('verify-claim keeps its verdict contract and receives the same canon provenance', async () => {
    const agent = AGENTS.grok!
    const originalBin = agent.bin
    const originalArgv = agent.argv
    const script = join(dir, 'fake-grok-verify-claim.sh')
    writeFileSync(script, `#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init"}'
printf '%s\n' '{"type":"result","subtype":"success","result":"{\\"verdict\\":\\"true\\",\\"provenance\\":{\\"canon_source\\":\\"mirror\\"}}"}'
`)
    chmodSync(script, 0o755)
    let sent = ''
    let sentSchema: string | undefined
    agent.bin = script
    agent.argv = ({ prompt, schema }) => {
      sent = prompt
      sentSchema = schema
      return []
    }
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      const result = await runJob({
        job: 'verify-claim', prompt: 'verify this', cwd: dir, agent: 'grok', mcp: false,
      })
      expect(result.status).toBe('ok')
      expect(sent).toContain(canonSourceInstruction('unknown'))
      expect(JSON.parse(readFileSync(sentSchema!, 'utf8'))).toEqual(VERIFY_CLAIM_SCHEMA)
    } finally {
      agent.bin = originalBin
      agent.argv = originalArgv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('detached orch do records a cwd-preflight refusal before grok starts', async () => {
    const cwd = realpathSync(dir)
    upsertProject({ name: 'fixture-project', path: cwd, settings: {} })
    const binDir = join(dir, 'mcp-dispatch-bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'grok'), `#!/bin/sh
if case " $* " in *" mcp doctor "*) true ;; *) false ;; esac; then
  printf '%s' '{"servers":[{"name":"fixture-project","healthy":false,"checks":[{"label":"unavailable","passed":false,"detail":"server down"}]}]}'
  exit 0
fi
echo should-not-launch >&2
exit 99
`)
    chmodSync(join(binDir, 'grok'), 0o755)
    const CLI = new URL('cli.ts', import.meta.url).pathname
    const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n
    const result = Bun.spawnSync(
      [process.execPath, CLI, 'do', 'review-lens', 'review this', '--mcp', '--agent', 'grok', '--lens', 'probe'],
      {
        cwd,
        env: {
          ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: 'orch-test-session',
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
        },
        stdout: 'pipe', stderr: 'pipe',
      },
    )
    expect(result.exitCode).toBe(0)
    const id = Number(result.stdout.toString().trim())
    const deadline = Date.now() + 5_000
    let row: { status: string; error: string | null } | null = null
    while (Date.now() < deadline) {
      row = db().query('SELECT status, error FROM run WHERE id=?').get(id) as
        { status: string; error: string | null } | null
      if (row && row.status !== 'running') break
      await Bun.sleep(20)
    }
    const finalRow = db().query('SELECT status, error FROM run WHERE id=?').get(id) as
      { status: string; error: string | null } | null
    expect(finalRow?.status).toBe('failed')
    expect(finalRow?.error).toContain("MCP was requested, but server 'fixture-project' could not be attached")
    expect(finalRow?.error).toContain('unavailable: server down')
    expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before + 1)
  })

  test('a fan-out of grok --mcp records one pre-spawn refusal per worker tree', async () => {
    const cwd = realpathSync(dir)
    upsertProject({ name: 'fixture-project', path: cwd, settings: {} })
    const binDir = join(dir, 'mcp-fanout-bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'grok'), `#!/bin/sh
if case " $* " in *" mcp doctor "*) true ;; *) false ;; esac; then
  printf '%s' '{"servers":[{"name":"fixture-project","healthy":false,"checks":[{"label":"unavailable","passed":false,"detail":"server down"}]}]}'
  exit 0
fi
echo should-not-launch >&2
exit 99
`)
    chmodSync(join(binDir, 'grok'), 0o755)
    const CLI = new URL('cli.ts', import.meta.url).pathname
    const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n
    const env = {
      ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
      CLAUDE_CODE_SESSION_ID: 'orch-test-session',
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    }
    const children = [1, 2, 3].map((n) => Bun.spawn(
      [process.execPath, CLI, 'do', 'review-lens', `lens ${n}`, '--mcp', '--agent', 'grok', '--lens', 'probe'],
      { cwd, env, stdout: 'pipe', stderr: 'pipe' },
    ))
    const codes = await Promise.all(children.map(async (child) => {
      const err = await new Response(child.stderr).text()
      const code = await child.exited
      return { code, err }
    }))
    expect(codes.every((row) => row.code === 0)).toBe(true)
    const deadline = Date.now() + 5_000
    let rows: { status: string; error: string | null }[] = []
    while (Date.now() < deadline) {
      rows = db().query('SELECT status, error FROM run WHERE id>? ORDER BY id').all(before) as typeof rows
      if (rows.length === 3 && rows.every((row) => row.status !== 'running')) break
      await Bun.sleep(20)
    }
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.status === 'failed')).toBe(true)
    expect(rows.every((row) => row.error?.includes(
      "MCP was requested, but server 'fixture-project' could not be attached",
    ))).toBe(true)
  })
})
