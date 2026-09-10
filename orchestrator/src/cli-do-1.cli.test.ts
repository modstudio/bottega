import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync, chmodSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { OrchRunEnvelopeSchema } from '../../shared/orch-contract.ts'
import { runJson, AGENTS, JOBS, RUNS_DIR, addRun, bootstrapFixtureStore, callerDrift, db, declaredCreate, detachedRunOptions, dir, hermeticGitEnv, setDoc, upsertProject } from '../test/fixture.ts'
import { MAIN_CHECKOUT_INVARIANT, mainCheckoutWorktreeHint } from './projects.ts'

import { runCollectionDescribeFixture } from '../test/fixture.ts'

describe("detached run collection", () => {
  const { CLI, orchInput, orch, orchFrom, insert, dispatchArtifacts, expectNoDispatchArtifacts, conflictingImplement } = runCollectionDescribeFixture()
test('every --json surface has an enumerated and pinned output contract', () => {
    const monitorDb = join(dir, 'json-contract-orch.db')
    const hubDb = join(dir, 'json-contract-hub.db')
    const binDir = join(dir, 'json-contract-bin')
    mkdirSync(binDir)
    writeFileSync(join(binDir, 'docker'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(binDir, 'docker'), 0o755)
    const monitorEnv = {
      ORCH_DB: monitorDb, HUB_DB: hubDb, PATH: `${binDir}:${process.env.PATH ?? ''}`,
    }
    bootstrapFixtureStore(monitorDb)
    bootstrapFixtureStore(process.env.ORCH_DB!)
    upsertProject({ name: 'json-source', path: '/w/json-source', settings: {} })
    upsertProject({ name: 'json-target', path: '/w/json-target',
      settings: { keyPrefixes: ['TGT'] } })
    setDoc({ scope: 'global', subject: null, slug: 'json-show', title: 'Show', body: 'body' })
    setDoc({
      scope: 'global', subject: null, slug: 'json-consume', title: 'Consume',
      body: '---\nstatus: open\nepic: json\nproject: json-target\nwritten: 2026-09-04T00:00:00.000Z\n---\n\nNEXT ACTION\n',
    })
    setDoc({ scope: 'global', subject: null, slug: 'json-rm', title: 'Remove', body: 'body' })
    const sources = JSON.stringify([
      { project: 'json-source', commits: ['abc'], paths: ['src/a.ts'], note: 'origin' },
    ])

    const documents: {
      command: string; args: string[]; stdin?: string; env?: Record<string, string>; code?: number
    }[] = [
      { command: 'review calibration', args: ['review', 'calibration', 'safety', 'codex', 'model', '--json'] },
      { command: 'search', args: ['search', 'no-match', '--json'] },
      { command: 'blockers', args: ['blockers', '--json'] },
      { command: 'inbox', args: ['inbox', '--all', '--json'] },
      { command: 'project list', args: ['project', 'list', '--json'] },
      { command: 'project add', args: ['project', 'add', dir, '--name', 'json-added', '--no-canon', '--json'] },
      { command: 'project set', args: ['project', 'set', 'json-added', '--stack', 'node', '--json'] },
      { command: 'doc list', args: ['doc', 'list', '--json'] },
      { command: 'doc show', args: ['doc', 'show', 'json-show', '--scope', 'global', '--json'] },
      { command: 'doc set', args: ['doc', 'set', 'json-set', '--scope', 'global', '--title', 'Set', '--reason', 'json test', '--json'], stdin: 'body' },
      { command: 'doc consume', args: ['doc', 'consume', 'json-consume', '--scope', 'global', '--json'] },
      { command: 'doc rm', args: ['doc', 'rm', 'json-rm', '--scope', 'global', '--reason', 'json test', '--json'] },
      { command: 'doc subjects', args: ['doc', 'subjects', '--json'] },
      { command: 'workflow list', args: ['workflow', 'list', '--json'] },
      { command: 'workflow show', args: ['workflow', 'show', 'ship', '--json'] },
      { command: 'workflow versions', args: ['workflow', 'versions', 'ship', '--json'] },
      { command: 'workflow compose', args: ['workflow', 'compose', 'ship', '--arg', 'key=DEV-257', '--arg', 'branch=feature/DEV-257', '--arg', 'worktree=/tmp/tree', '--json'] },
      { command: 'workflow step', args: ['workflow', 'step', 'ship', 'lens', '--arg', 'key=DEV-257', '--arg', 'branch=feature/DEV-257', '--arg', 'worktree=/tmp/tree', '--json'] },
      { command: 'review coverage-audit', args: ['review', 'coverage-audit', '--json'] },
      { command: 'port baseline show', args: ['port', 'baseline', 'show', 'json-source', 'json-target', '--json'] },
      { command: 'port baseline set', args: ['port', 'baseline', 'set', 'json-source', 'json-target', 'abc', '--json'] },
      { command: 'port skip list', args: ['port', 'skip', 'list', 'json-source', 'json-target', '--json'] },
      { command: 'port skip add', args: ['port', 'skip', 'add', 'json-source', 'json-target', 'old', '--reason', 'superseded', '--json'] },
      { command: 'port ref set', args: ['port', 'ref', 'set', 'TGT-210', '--sources', sources, '--note', 'native', '--json'] },
      { command: 'port ref list', args: ['port', 'ref', 'list', '--all', '--json'] },
      { command: 'port ref show', args: ['port', 'ref', 'show', 'TGT-210', '--json'] },
      { command: 'port ref resolve', args: ['port', 'ref', 'resolve', 'TGT-210', '--json'] },
      { command: 'port ref delete-error', args: ['port', 'ref', 'delete-error', 'TGT-210', '--json'] },
      { command: 'port doctrine add', args: ['port', 'doctrine', 'add', '210', '--title', 'Native', '--json'], stdin: 'Adapt natively.' },
      { command: 'port doctrine list', args: ['port', 'doctrine', 'list', '--all', '--json'] },
      { command: 'port doctrine retire', args: ['port', 'doctrine', 'retire', '210', '--json'] },
      { command: 'monitor history', args: ['monitor', '--history', '--json'], env: monitorEnv },
      { command: 'monitor', args: ['monitor', '--json'], code: 1,
        env: monitorEnv },
      { command: 'canon evals', args: ['canon', 'evals', '--json'] },
    ]

    expect(documents).toHaveLength(34)
    for (const surface of documents) {
      const result = orchInput(surface.args, surface.stdin, surface.env)
      expect(result.code, surface.command).toBe(surface.code ?? 0)
      expect(result.err, surface.command).toBe('')
      expect(() => JSON.parse(result.out), surface.command).not.toThrow()
    }

    insert('ok')
    insert('ok')
    const runs = orch('runs', '--json')
    expect(runs.code).toBe(0)
    expect(runs.err).toBe('')
    expect(() => JSON.parse(runs.out)).toThrow()
    const lines = runs.out.trim().split('\n')
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(OrchRunEnvelopeSchema.parse(JSON.parse(line))).toMatchObject({
        schema_version: 2, kind: 'run', data: { id: expect.any(Number) },
      })
    }

    const legacy = orch('runs', '--json=v1')
    expect(legacy.code).toBe(0)
    for (const line of legacy.out.trim().split('\n')) {
      expect(JSON.parse(line)).toMatchObject({ id: expect.any(Number) })
    }

    const help = orch('--help').out
    expect(help.match(/one JSON document/g)).toHaveLength(documents.length)
    expect(help.match(/one JSON object per line/g)).toHaveLength(1)
  }, 20_000)

  test('the detached spec mapping forwards every field to run', () => {
    const resume = {
      parent: 11, agent: 'codex', session: 'session', turn: 2, sessionId: 'owner',
      worktree: { path: '/tmp/tree', branch: 'DEV-63', base: 'main', repoRoot: '/tmp/repo' },
    }
    expect(detachedRunOptions('implement', 'prompt', 42, {
      agent: 'codex', schema: '/tmp/schema.json', mcp: true, model: 'model', probe: true,
      transport: 'cli',
      label: 'security lens', lens: 'security', seed: 'small', key: 'DEV-63', repo: 'project', base: 'main', avoid: ['grok'],
      distinctModels: ['other-model'], retryOf: 7, cwd: '/tmp/repo', noFailover: true,
      noWaitCapacity: true, carry: true,
      review: 'feature/DEV-63', ownerSession: 'owner', resume,
      deliverables: ['timing'], timeoutMinutes: 40, keepTree: true,
    })).toEqual({
      job: 'implement', prompt: 'prompt', reserveId: 42,
      agent: 'codex', schemaPath: '/tmp/schema.json', mcp: true, model: 'model', probe: true,
      transport: 'cli',
      label: 'security lens', lens: 'security', seed: 'small', key: 'DEV-63', repo: 'project', base: 'main', avoid: ['grok'],
      distinctModels: ['other-model'], retryOf: 7, cwd: '/tmp/repo', noFailover: true,
      noWaitCapacity: true, carry: true,
      review: 'feature/DEV-63', ownerSession: 'owner', resume,
      deliverables: ['timing'], timeoutMinutes: 40, keepTree: true,
    })
  })

  test('detach spawns exec.ts as its child entry point', () => {
    const cli = readFileSync(new URL('./cli.ts', import.meta.url).pathname, 'utf8')
    const detachSource = cli.slice(cli.indexOf('function detach('), cli.indexOf('function usage('))
    expect(detachSource).toContain("new URL('exec.ts', import.meta.url).pathname")
    expect(detachSource).not.toContain("new URL('cli.ts', import.meta.url).pathname")
  })

  test('three concurrent detached dispatches all claim rows in one store', async () => {
    const store = join(dir, `concurrent-detach-${randomUUID()}.db`)
    const runs = join(dir, `concurrent-detach-runs-${randomUUID()}`)
    const env = {
      ...process.env,
      ORCH_DB: store,
      ORCH_RUNS: runs,
      ORCH_DEPTH: '0',
      ORCH_EXEC_PATH: '/usr/bin/true',
      CLAUDE_CODE_SESSION_ID: 'orch-test-session',
    }
    bootstrapFixtureStore(store)

    const children = [1, 2, 3].map((n) => Bun.spawn(
      [process.execPath, CLI, 'do', 'file-question', `concurrent ${n}`, '--agent', 'codex', '--detach'],
      { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' },
    ))
    const results = await Promise.all(children.map(async (child) => ({
      code: await child.exited,
      out: await new Response(child.stdout).text(),
      err: await new Response(child.stderr).text(),
    })))

    expect(results.map(({ code }) => code)).toEqual([0, 0, 0])
    expect(results.map(({ out }) => Number(out.trim())).every((id) => id > 0)).toBe(true)
    expect(results.map(({ err }) => err).join('\n')).not.toContain('database is locked')
    const scratch = new Database(store)
    try {
      expect(scratch.query("SELECT COUNT(*) n FROM run WHERE agent='(pending)'").get())
        .toEqual({ n: 3 })
    } finally {
      scratch.close()
    }
  })

  test('detach with a bad execPath marks the reserved row failed/harness', () => {
    upsertProject({ name: 'spawn-fail', path: process.cwd() })
    const r = Bun.spawnSync([
      process.execPath, CLI, 'do', 'file-question', '--repo', 'spawn-fail', '--mcp=prefer', 'hello',
    ], {
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session',
        ORCH_EXEC_PATH: '/definitely/not-an-orch-exec-DEV-73',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(r.exitCode).not.toBe(0)
    const row = db().query(
      'SELECT agent, status, failure_kind, error, pid, mcp FROM run ORDER BY id DESC LIMIT 1',
    ).get() as {
      agent: string; status: string; failure_kind: string; error: string
      pid: number | null; mcp: number
    }
    expect(row.agent).toBe('(pending)')
    expect(row.status).toBe('failed')
    expect(row.failure_kind).toBe('harness')
    expect(row.error).toContain('spawn failed')
    expect(row.error).toContain('/definitely/not-an-orch-exec-DEV-73')
    expect(row.pid).toBeNull()
    expect(row.mcp).toBe(2)
  })

  test('a detached run has exactly one prompt file', () => {
    const binDir = join(dir, 'detach-bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nprintf \'answer\'\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    const p = Bun.spawnSync(
      [process.execPath, CLI, 'do', 'file-question', 'one prompt', '--agent', 'codex',
        '--label', 'security lens', '--detach'],
      { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: {
        ...process.env, PATH: `${binDir}:${process.env.PATH}`, ORCH_DB: process.env.ORCH_DB!,
        ORCH_DEPTH: '0', CLAUDE_CODE_SESSION_ID: 'orch-test-session', FORCE_COLOR: '1',
      } },
    )
    expect(p.exitCode).toBe(0)
    const id = Number(p.stdout.toString().trim())
    expect(id).toBeGreaterThan(0)
    expect(p.stderr.toString()).toContain(
      `detached as run ${id}: orch wait ${id}, then orch result ${id}`,
    )
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const row = db().query('SELECT status FROM run WHERE id=?').get(id) as { status: string }
      if (row.status !== 'running') break
      Bun.sleepSync(20)
    }
    const recorded = db().query(
      'SELECT label, prompt_head, prompt_path, spec_sha FROM run WHERE id=?',
    ).get(id) as { label: string; prompt_head: string; prompt_path: string; spec_sha: string }
    expect({ label: recorded.label, prompt_head: recorded.prompt_head })
      .toEqual({ label: 'security lens', prompt_head: 'one prompt' })
    expect(recorded.spec_sha)
      .toBe(createHash('sha256').update('one prompt').digest('hex').slice(0, 16))
    const listed = orch('runs', '--limit', '1')
    expect(listed.out).toContain('security lens')
    expect(listed.out).not.toContain('one prompt')
    const pending = orch('pending')
    expect(pending.out).toContain('security lens')
    expect(pending.out).not.toContain('one prompt')
    const runsDir = RUNS_DIR
    expect(recorded.prompt_path).toContain(`-${id}-`)
    expect(existsSync(recorded.prompt_path)).toBe(true)
    expect(readdirSync(runsDir).filter(
      (name) => name.includes(`-${id}-`) && name.endsWith('.prompt.txt'),
    )).toHaveLength(1)
    for (const name of readdirSync(runsDir).filter((name) => name.includes(`-${id}-`))) {
      rmSync(join(runsDir, name), { force: true })
    }
  }, 15_000)

  test('--cwd carry measures the same input tree as launching inside that worktree', () => {
    const repo=realpathSync(mkdtempSync(join(tmpdir(),'orch-cwd-repo-'))), linked=join(repo,'.claude','worktrees','DEV-257-caller')
    const binDir=mkdtempSync(join(tmpdir(),'orch-cwd-bin-'))
    const git=(cwd:string,...args:string[])=>{const p=Bun.spawnSync(['git',...args],{cwd,env:hermeticGitEnv(),stdout:'pipe',stderr:'pipe'});if(p.exitCode!==0)throw new Error(p.stderr.toString());return p.stdout.toString().trim()}
    try {
      git(repo,'init','-b','main');git(repo,'config','user.email','orch-test@example.invalid');git(repo,'config','user.name','Orch Test')
      writeFileSync(join(repo,'tracked.txt'),'base\n');git(repo,'add','.');git(repo,'commit','-m','fixture')
      mkdirSync(join(repo,'.claude','worktrees'),{recursive:true});git(repo,'worktree','add','-b','feature/DEV-257',linked,'main')
      writeFileSync(join(linked,'tracked.txt'),'carried\n');writeFileSync(join(linked,'untracked.txt'),'visible\n')
      writeFileSync(join(binDir,'codex'),'#!/bin/sh\nprintf answer\n');chmodSync(join(binDir,'codex'),0o755)
      upsertProject({name:'cwd-project',path:repo,canon:false,settings:{}})
      const launch=(cwd:string,args:string[])=>{const p=Bun.spawnSync([process.execPath,CLI,'do','file-question','inspect','--agent','codex','--carry','--porcelain',...args],{cwd,env:{...process.env,ORCH_DB:process.env.ORCH_DB!,ORCH_DEPTH:'0',PATH:`${binDir}:${process.env.PATH ?? ''}`},stdout:'pipe',stderr:'pipe'});expect(p.exitCode,p.stderr.toString()).toBe(0);return Number(p.stdout.toString().trim())}
      const fromRoot=launch(repo,['--cwd',linked]), fromTree=launch(linked,[])
      for(const id of [fromRoot,fromTree]) {const deadline=Date.now()+5000;while(Date.now()<deadline){const row=db().query('SELECT status FROM run WHERE id=?').get(id) as {status:string};if(row.status!=='running')break;Bun.sleepSync(20)}}
      const trees=[fromRoot,fromTree].map((id)=>(db().query('SELECT input_tree FROM run WHERE id=?').get(id) as {input_tree:string}).input_tree)
      expect(trees[0]).toBeTruthy();expect(trees[0]).toBe(trees[1])
    } finally { rmSync(repo,{recursive:true,force:true});rmSync(binDir,{recursive:true,force:true}) }
  }, 15_000)

  test('fix --base creates its worktree at the requested commit', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-fix-base-')))
    const binDir = mkdtempSync(join(tmpdir(), 'orch-fix-base-bin-'))
    const git = (cwd: string, ...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      git(repo, 'init', '-b', 'main')
      git(repo, 'config', 'user.email', 'orch-test@example.invalid')
      git(repo, 'config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'tracked.txt'), 'base\n')
      git(repo, 'add', '.')
      git(repo, 'commit', '-m', 'fixture base')
      const requested = git(repo, 'rev-parse', 'HEAD')
      git(repo, 'tag', '-a', 'requested-tag', '-m', 'fixture tag', requested)
      writeFileSync(join(repo, 'tracked.txt'), 'later\n')
      git(repo, 'commit', '-am', 'fixture later')
      writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nprintf answer\n')
      chmodSync(join(binDir, 'codex'), 0o755)
      upsertProject({
        name: 'fix-base', path: repo, canon: false,
        settings: { worktree: { recipe: {}, branch: '{key}-orch-{id}' } },
      })

      const launched = Bun.spawnSync([
        process.execPath, CLI, 'do', 'fix', 'apply the correction', '--agent', 'codex',
        '--key', 'DEV-173', '--base', 'requested-tag', '--porcelain',
      ], {
        cwd: repo, stdout: 'pipe', stderr: 'pipe', env: {
          ...hermeticGitEnv(), PATH: `${binDir}:${process.env.PATH ?? ''}`,
          ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: 'orch-test-session',
        },
      })
      expect(launched.exitCode, launched.stderr.toString()).toBe(0)
      const id = Number(launched.stdout.toString().trim())
      expect(id).toBeGreaterThan(0)
      const deadline = Date.now() + 5_000
      let row: { status: string; worktree: string | null; base_commit: string | null } | undefined
      while (Date.now() < deadline) {
        row = db().query(
          'SELECT status, worktree, base_commit FROM run WHERE id=?',
        ).get(id) as typeof row
        if (row?.worktree && row.status !== 'running') break
        Bun.sleepSync(20)
      }
      expect(row?.worktree).toBeTruthy()
      expect(row?.base_commit).toBe(requested)
      expect(git(row!.worktree!, 'rev-parse', 'HEAD')).toBe(requested)
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  }, 15_000)

  test('--follow names the branch minted by a writing run', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-follow-branch-')))
    const binDir = mkdtempSync(join(tmpdir(), 'orch-follow-branch-bin-'))
    const git = (cwd: string, ...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      git(repo, 'init', '-b', 'main')
      git(repo, 'config', 'user.email', 'orch-test@example.invalid')
      git(repo, 'config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'tracked.txt'), 'base\n')
      git(repo, 'add', '.')
      git(repo, 'commit', '-m', 'fixture base')
      writeFileSync(
        join(binDir, 'codex'),
        '#!/bin/sh\nprintf \'%s\\n\' \'{"status":"done","summary":"proof","files_changed":[],"questions":null,"deviations":null,"blockers":null,"tests":null}\'\n',
      )
      chmodSync(join(binDir, 'codex'), 0o755)
      upsertProject({
        name: 'follow-branch', path: repo, canon: false,
        settings: { worktree: { recipe: {}, branch: '{key}-orch-{id}' } },
      })

      const followed = Bun.spawnSync([
        process.execPath, CLI, 'do', 'fix', 'report the branch', '--agent', 'codex',
        '--key', 'DEV-436', '--base', 'main', '--follow',
      ], {
        cwd: repo, stdout: 'pipe', stderr: 'pipe', env: {
          ...hermeticGitEnv(), PATH: `${binDir}:${process.env.PATH ?? ''}`,
          ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: 'orch-test-session',
        },
      })
      const recorded = db().query(
        "SELECT minted_branch FROM run WHERE job='fix' ORDER BY id DESC LIMIT 1",
      ).get() as
        { minted_branch: string }

      expect(followed.exitCode, followed.stderr.toString()).toBe(0)
      expect(recorded.minted_branch).toBeTruthy()
      expect(followed.stderr.toString()).toContain(recorded.minted_branch)
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  }, 15_000)

  test('do help names every job and every supported flag', () => {
    for (const help of ['--help', '-h']) {
      const r = orch('do', help)
      expect(r.code).toBe(0)
      for (const name of Object.keys(JOBS)) expect(r.out).toContain(name)
      for (const name of [
        '--agent', '--schema', '--mcp', '--model', '--label', '--probe', '--seed', '--key',
        '--repo', '--base', '--carry', '--avoid', '--distinct-from', '--file', '--detach', '--follow', '--quiet',
        '--no-failover', '--no-wait-capacity', '--porcelain', '--cwd',
      ]) expect(r.out).toContain(name)
    }
  })

  test('dispatch preflight enforces a clean registered main checkout', () => {
    const git = (cwd: string, ...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
      return result.stdout.toString().trim()
    }
    const makeRepo = (name: string) => {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), `orch-main-${name}-`)))
      git(repo, 'init', '-b', 'main')
      git(repo, 'config', 'user.email', 'orch-test@example.invalid')
      git(repo, 'config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'tracked.txt'), 'fixture\n')
      writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n')
      git(repo, 'add', '.')
      git(repo, 'commit', '-m', 'fixture')
      return repo
    }
    const binDir = mkdtempSync(join(tmpdir(), 'orch-main-bin-'))
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nprintf answer\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    const dispatch = (repo: string, extra: string[] = []) => Bun.spawnSync(
      [process.execPath, CLI, 'do', 'file-question', 'inspect', '--agent', 'codex', '--porcelain', ...extra],
      {
        cwd: repo, stdout: 'pipe', stderr: 'pipe',
        env: {
          ...hermeticGitEnv(), PATH: `${binDir}:${process.env.PATH ?? ''}`,
          ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: 'orch-test-session',
        },
      },
    )
    const repos: string[] = []
    try {
      const clean = makeRepo('clean')
      repos.push(clean)
      upsertProject({ name: 'main-clean', path: clean, canon: false, settings: {} })
      const ok = dispatch(clean)
      expect(ok.exitCode, ok.stderr.toString()).toBe(0)
      expect(ok.stdout.toString()).toMatch(/^\d+\n$/)
      expect(ok.stderr.toString()).not.toContain('untracked files')
      expect(ok.stderr.toString()).not.toContain('tracked modifications')

      const dirty = makeRepo('dirty')
      repos.push(dirty)
      upsertProject({ name: 'main-dirty', path: dirty, canon: false, settings: {} })
      writeFileSync(join(dirty, 'tracked.txt'), 'changed\n')
      const runsBefore = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n
      const refused = dispatch(dirty)
      expect(refused.exitCode).not.toBe(0)
      expect(refused.stdout.toString()).toBe('')
      expect(refused.stderr.toString()).toContain('tracked.txt')
      expect(refused.stderr.toString()).toContain(`work from a worktree under ${mainCheckoutWorktreeHint(dirty)} instead`)
      expect(refused.stderr.toString()).toContain(`invariant: ${MAIN_CHECKOUT_INVARIANT}`)
      expect(refused.stderr.toString()).toContain(`cleared by: orch do --cwd '${mainCheckoutWorktreeHint(dirty)}/<tree>'`)
      expect(refused.stderr.toString()).not.toContain('stash')
      expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(runsBefore)

      const untracked = makeRepo('untracked')
      repos.push(untracked)
      upsertProject({ name: 'main-untracked', path: untracked, canon: false, settings: {} })
      writeFileSync(join(untracked, 'scratch.db'), 'untracked\n')
      const warned = dispatch(untracked)
      expect(warned.exitCode, warned.stderr.toString()).toBe(0)
      expect(warned.stdout.toString()).toMatch(/^\d+\n$/)
      expect(warned.stderr.toString()).toContain('scratch.db')
      expect(warned.stderr.toString()).toContain('they do not block dispatch')
      expect(warned.stderr.toString()).not.toContain('tracked modifications')

      const ignored = makeRepo('ignored')
      repos.push(ignored)
      upsertProject({ name: 'main-ignored', path: ignored, canon: false, settings: {} })
      writeFileSync(join(ignored, 'ignored.txt'), 'ignored\n')
      const silent = dispatch(ignored)
      expect(silent.exitCode, silent.stderr.toString()).toBe(0)
      expect(silent.stdout.toString()).toMatch(/^\d+\n$/)
      expect(silent.stderr.toString()).not.toContain('ignored.txt')
      expect(silent.stderr.toString()).not.toContain('untracked files')
      expect(silent.stderr.toString()).not.toContain('tracked modifications')

      const exempt = makeRepo('exempt')
      repos.push(exempt)
      upsertProject({
        name: 'main-exempt', path: exempt, canon: false,
        settings: { requireCleanMain: false },
      })
      writeFileSync(join(exempt, 'tracked.txt'), 'still dirty\n')
      const allowed = dispatch(exempt)
      expect(allowed.exitCode, allowed.stderr.toString()).toBe(0)
      expect(allowed.stdout.toString()).toMatch(/^\d+\n$/)
      expect(allowed.stderr.toString()).not.toContain('tracked modifications')

      const stale = makeRepo('stale')
      repos.push(stale)
      upsertProject({ name: 'main-stale', path: stale, canon: false, settings: {} })
      utimesSync(join(stale, 'tracked.txt'), 1, 1)
      const staleIndex = Bun.spawnSync(
        ['git', '-C', stale, 'diff-index', '--quiet', 'HEAD', '--'],
        { env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' },
      )
      expect(staleIndex.exitCode).toBe(1)
      const refreshed = dispatch(stale)
      expect(refreshed.exitCode, refreshed.stderr.toString()).toBe(0)
      expect(refreshed.stdout.toString()).toMatch(/^\d+\n$/)
      expect(refreshed.stderr.toString()).not.toContain('tracked modifications')

      const locked = makeRepo('locked')
      repos.push(locked)
      upsertProject({ name: 'main-locked', path: locked, canon: false, settings: {} })
      utimesSync(join(locked, 'tracked.txt'), 1, 1)
      writeFileSync(join(locked, '.git', 'index.lock'), '')
      const contended = dispatch(locked)
      expect(contended.exitCode, contended.stderr.toString()).toBe(0)
      expect(contended.stdout.toString()).toMatch(/^\d+\n$/)
      expect(contended.stderr.toString()).not.toContain('tracked modifications')
    } finally {
      rmSync(binDir, { recursive: true, force: true })
      for (const repo of repos) rmSync(repo, { recursive: true, force: true })
    }
  }, 20_000)

  test('a missing required dispatch flag exits non-zero without claiming a run', () => {
    upsertProject({
      name: 'requires-seed', path: process.cwd(),
      settings: {
        worktree: {
          create: declaredCreate('scripts/worktree', ['create', '{branch}', '{seed}']), branch: 'task/{id}',
          seeds: ['small', 'full'],
        },
      },
    })
    const before = dispatchArtifacts(process.cwd())
    const r = orch('do', 'implement', 'make the change', '--porcelain')
    expect(r.code).not.toBe(0)
    expect(r.out).toBe('')
    expect(r.err).toContain('this project requires a database size')
    expectNoDispatchArtifacts(process.cwd(), before)
  })

  test('a writing run missing its branch key exits before git and does not claim a run', () => {
    upsertProject({
      name: PLATFORM_SLUG, path: process.cwd(),
      settings: { worktree: { recipe: {}, branch: '{key}-orch-{id}' } },
    })
    const before = dispatchArtifacts(process.cwd())
    const r = orch('do', 'implement', 'make the change', '--porcelain')

    expect(r.code).not.toBe(0)
    expect(r.out).toBe('')
    expect(r.err).toContain(
      `this project's branch names must carry a ticket key ({key}-orch-{id}), and orch will ` +
      `not invent one.\n  --key <KEY-123>`,
    )
    expect(r.err).not.toContain('git worktree')
    expectNoDispatchArtifacts(process.cwd(), before)
  })

  test('every repository-reading job refuses a non-git cwd without dispatch artifacts', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'orch-reads-no-git-')))
    try {
      for (const [name, definition] of Object.entries(JOBS)) {
        if (!definition.needs.readsRepo) continue
        const before = dispatchArtifacts(outside)
        const extra = definition.findings ? ['--lens', 'preflight'] : []
        const r = orchFrom(outside, 'orch-test-session', 'do', name, 'inspect', ...extra)
        expect(r.code, name).not.toBe(0)
        if (name === 'review-lens') {
          expect(r.err, name).toContain('a review lens reads a change')
        } else {
          expect(r.err, name).toContain(
            `${name} reads a repository and ${outside} is not a git checkout`,
          )
        }
        expectNoDispatchArtifacts(outside, before)
      }
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  }, 20_000)

  test('orch do accepts every documented starship seed spelling before execution', () => {
    upsertProject({
      name: 'starship-seed-grammar', path: process.cwd(),
      settings: {
        worktree: {
          recipe: {}, branch: '{key}-orch-{id}',
          seeds: ['none', '--bundle=minimal', '--tables=account,order', '--full'],
        },
      },
    })
    const missingPrompt = '/definitely/missing/DEV-242-prompt'
    const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n
    const spellings = [
      ['--seed', 'none'],
      ['--seed', '--bundle=minimal'],
      ['--seed', '--tables=account,order'],
      ['--seed', '--full'],
      ['--seed=--bundle=minimal'],
      ['--seed', ' --bundle=minimal'],
    ]
    for (const spelling of spellings) {
      const result = orch(
        'do', 'implement', ...spelling, '--key', 'DEV-242', '--file', missingPrompt,
      )
      expect(result.code, spelling.join(' ')).not.toBe(0)
      expect(result.err, spelling.join(' ')).toContain(missingPrompt)
      expect(result.err, spelling.join(' ')).not.toContain('unrecognised argument')
      expect(result.err, spelling.join(' ')).not.toContain('needs a value')
    }
    expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before)
  }, 20_000)

  test('--porcelain prints only a parseable run id on a successful dispatch', () => {
    const binDir = join(dir, 'porcelain-bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nprintf \'answer\'\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    const p = Bun.spawnSync(
      [process.execPath, CLI, 'do', 'file-question', 'one prompt', '--agent', 'codex', '--porcelain'],
      { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: {
        ...process.env, PATH: `${binDir}:${process.env.PATH}`, ORCH_DB: process.env.ORCH_DB!,
        ORCH_DEPTH: '0', CLAUDE_CODE_SESSION_ID: 'orch-test-session', FORCE_COLOR: '1',
      } },
    )
    const stdout = p.stdout.toString()
    expect(p.exitCode).toBe(0)
    expect(stdout).toMatch(/^\d+\n$/)
    expect(Number(stdout.trim())).toBeGreaterThan(0)
    expect(p.stderr.toString()).toBe('')
  })

  test('an implement contract conflict names the started run on stderr', () => {
    const p = conflictingImplement([])
    expect(p.exitCode).toBe(0)
    const stdout = p.stdout.toString()
    expect(stdout).toMatch(/^\d+\n$/)
    const id = Number(stdout.trim())
    expect(id).toBeGreaterThan(0)
    const err = p.stderr.toString()
    expect(err).toContain('implement spec may conflict with its no-push/no-merge/no-rewrite contract')
    expect(err).toContain('line 2: Then push the branch.')
    expect(err).toContain(`The spec was not changed. Run ${id} has started;`)
    expect(err).toContain('review the spec before the worker reaches this conflict')
  })

  test('--porcelain with an implement contract conflict still prints only the run id', () => {
    const p = conflictingImplement(['--porcelain'])
    const stdout = p.stdout.toString()
    expect(p.exitCode).toBe(0)
    expect(stdout).toMatch(/^\d+\n$/)
    expect(Number(stdout.trim())).toBeGreaterThan(0)
    expect(p.stderr.toString()).toBe('')
    expect(stdout).not.toContain('may conflict')
    expect(stdout).not.toContain('has started')
  })

  test('--porcelain refuses --follow because following cannot print only an id', () => {
    const r = orch('do', 'file-question', 'one prompt', '--porcelain', '--follow')
    expect(r.code).not.toBe(0)
    expect(r.out).toBe('')
    expect(r.err).toContain('--porcelain cannot be combined with --follow')
  })

  test("do help says when the current project's create template cannot carry a base", () => {
    upsertProject({
      name: 'cannot-base', path: process.cwd(),
      settings: {
        worktree: {
          create: declaredCreate('scripts/worktree', ['create', '{branch}']), branch: 'feature/{id}',
        },
      },
    })

    const r = orch('do', '--help')
    expect(r.code).toBe(0)
    expect(r.out).toContain(
      '--base <ref>     base an implement, fix or land worktree on this verified git commit',
    )
    expect(r.out).not.toContain('unsupported for this project')
  })

  test("do help does not warn when the current project's create template carries a base", () => {
    upsertProject({
      name: 'can-base', path: process.cwd(),
      settings: {
        worktree: {
          create: declaredCreate('scripts/worktree', ['create', '{branch}', '{base}']), branch: 'feature/{id}',
        },
      },
    })

    const r = orch('do', '--help')
    expect(r.code).toBe(0)
    expect(r.out).toContain('--base <ref>     base an implement, fix or land worktree on this verified git commit')
    expect(r.out).not.toContain('unsupported for this project')
  })

  test('a Codex schema rejected in preflight leaves no run row', () => {
    const schema = join(dir, 'unsupported-codex-schema.json')
    writeFileSync(schema, JSON.stringify({
      type: 'object', properties: {}, patternProperties: { '^x': { type: 'string' } },
    }))
    const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n
    const r = orch('do', 'file-question', 'answer this', '--agent', 'codex', '--schema', schema)
    expect(r.code).toBe(1)
    expect(r.err).toContain('$.patternProperties')
    expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before)
  })

  test('runs --unscored uses the shared definition of an owed judgement', () => {
    const wanted = addRun({ agent: 'grok', job: 'craft' })
    addRun({ agent: 'grok', job: 'craft', probe: 1 })
    addRun({ agent: 'grok', job: 'craft', status: 'failed' })
    addRun({ agent: 'grok', job: 'craft', status: 'running' })
    const parent = addRun({ agent: 'grok', job: 'craft', status: 'failed' })
    addRun({ agent: 'grok', job: 'craft', parent, turn: 2 })

    const r = orch('runs', '--unscored', '--json')
    expect(r.code).toBe(0)
    expect(r.err).toBe('')
    const rows = r.out.trim().split('\n').filter(Boolean).map(runJson)
    expect(rows.map((row) => row.id)).toEqual([wanted])
  })

  test('pick previews the same fan-out exclusions do uses', () => {
    const prior = insert('ok', 'review-lens')
    db().query('UPDATE run SET agent=?, model=? WHERE id=?')
      .run('grok', AGENTS.grok!.model, prior)

    const avoided = orch('pick', 'review-lens', '--avoid', 'grok')
    expect(avoided.code).toBe(0)
    expect(avoided.out).toContain('review-lens -> codex')

    const distinct = orch('pick', 'review-lens', '--distinct-from', String(prior))
    expect(distinct.code).toBe(0)
    expect(distinct.out).toContain('review-lens -> codex')
  })

  test('a drifted caller is signalled once before a fan-out, while an up-to-date one is quiet', () => {
    mkdirSync(join(dir, 'early-drift-signal'))
    const repo = realpathSync(join(dir, 'early-drift-signal'))
    const git = (args: string[], stdin?: string) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
        stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    git(['init', '-b', 'main'])
    git(['commit', '--allow-empty', '-m', 'base'])
    const head = git(['rev-parse', 'HEAD'])
    git(['update-ref', 'refs/remotes/origin/main', head])
    upsertProject({
      name: 'early-drift', path: repo,
      settings: {
        trunk: 'main',
        worktree: { create: declaredCreate('scripts/worktree', ['create', '{branch}']), branch: 'task/{id}' },
      },
    })

    const pick = () => {
      const p = Bun.spawnSync([process.execPath, CLI, 'pick', 'implement'], {
        cwd: repo, stdout: 'pipe', stderr: 'pipe',
        env: {
          ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: 'early-drift-session',
        },
      })
      return { code: p.exitCode, err: p.stderr.toString() }
    }

    const current = pick()
    expect(current.code).toBe(0)
    expect(current.err).not.toContain('caller checkout HEAD')

    const tree = git(['rev-parse', 'HEAD^{tree}'])
    const newer = git(['commit-tree', tree, '-p', head], 'newer base\n')
    git(['update-ref', 'refs/remotes/origin/main', newer])
    expect(callerDrift(repo)).toEqual({ callerHead: head, base: newer, baseRef: 'origin/main' })
    const first = pick()
    const sibling = pick()
    expect(first.code).toBe(0)
    expect(first.err).toContain(`caller checkout HEAD ${head} is behind or diverged`)
    expect(first.err).toContain(`origin/main (${newer})`)
    expect(first.err).toContain('repository runs from it are still dispatched')
    expect(first.err).not.toContain('will be refused')
    expect(sibling.code).toBe(0)
    expect(sibling.err).not.toContain('caller checkout HEAD')
  }, 20_000)

  test('a drifted caller still dispatches, and --porcelain still prints only the run id', () => {
    mkdirSync(join(dir, 'drift-dispatch'))
    const repo = realpathSync(join(dir, 'drift-dispatch'))
    const git = (args: string[], stdin?: string) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
        stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    git(['init', '-b', 'main'])
    git(['commit', '--allow-empty', '-m', 'base'])
    const head = git(['rev-parse', 'HEAD'])
    git(['update-ref', 'refs/remotes/origin/main', head])
    upsertProject({
      name: 'drift-dispatch', path: repo,
      settings: {
        trunk: 'main',
        worktree: { recipe: { baseRef: 'origin/main' }, branch: 'task/{id}' },
      },
    })
    const tree = git(['rev-parse', 'HEAD^{tree}'])
    const newer = git(['commit-tree', tree, '-p', head], 'newer base\n')
    git(['update-ref', 'refs/remotes/origin/main', newer])
    expect(callerDrift(repo)).toEqual({ callerHead: head, base: newer, baseRef: 'origin/main' })

    const binDir = join(dir, 'drift-dispatch-bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nprintf \'answer\'\n')
    chmodSync(join(binDir, 'codex'), 0o755)

    const dispatch = (extra: string[], session: string) => Bun.spawnSync(
      [process.execPath, CLI, 'do', 'file-question', 'what is here', '--agent', 'codex', ...extra],
      {
        cwd: repo, stdout: 'pipe', stderr: 'pipe',
        env: {
          ...process.env, PATH: `${binDir}:${process.env.PATH}`,
          ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: session,
        },
      },
    )

    const human = dispatch([], 'drift-dispatch-human')
    expect(human.exitCode).toBe(0)
    expect(human.stdout.toString()).toMatch(/^\d+\n$/)
    expect(human.stderr.toString()).toContain(`caller checkout HEAD ${head} is behind or diverged`)
    expect(human.stderr.toString()).toContain('repository runs from it are still dispatched')
    expect(human.stderr.toString()).not.toContain('will be refused')

    const porcelain = dispatch(['--porcelain'], 'drift-dispatch-porcelain')
    expect(porcelain.exitCode).toBe(0)
    expect(porcelain.stdout.toString()).toMatch(/^\d+\n$/)
    expect(Number(porcelain.stdout.toString().trim())).toBeGreaterThan(0)
    expect(porcelain.stderr.toString()).toContain(`caller checkout HEAD ${head} is behind or diverged`)
    expect(porcelain.stderr.toString()).toContain('repository runs from it are still dispatched')
    expect(porcelain.stderr.toString()).not.toContain('will be refused')
    expect(porcelain.stdout.toString()).not.toContain('behind or diverged')
  })

  test('pick shares do validation for fan-out exclusions', () => {
    const unknown = orch('pick', 'review-lens', '--avoid', 'nobody')
    expect(unknown.code).toBe(1)
    expect(unknown.err).toContain('unknown agent "nobody" in --avoid')

    const invalid = orch('pick', 'review-lens', '--distinct-from', 'not-a-run')
    expect(invalid.code).toBe(1)
    expect(invalid.err).toContain('--distinct-from expects comma-separated run ids')

    const contradictory = orch('pick', 'review-lens', '--agent', 'grok', '--avoid', 'grok')
    expect(contradictory.code).toBe(1)
    expect(contradictory.err).toContain('--agent grok contradicts --avoid grok')
  }, 20_000)

  test('pick refuses an unmet constraint instead of silently routing', () => {
    const r = orch('pick', 'review-lens', '--avoid', 'grok,codex')
    expect(r.code).toBe(1)
    expect(r.err).toContain('routing constraints leave no eligible agent')
    expect(r.err).toContain('codex: --avoid named codex')
    expect(r.err).toContain('grok: --avoid named grok')
  })

  test('jobs exposes fidelity only for writing jobs', () => {
    const r = orch('jobs')
    expect(r.code).toBe(0)
    const lines = r.out.trim().split('\n')
    expect(lines.find((line) => line.startsWith('implement'))).toContain('fidelity')
    expect(lines.find((line) => line.startsWith('fix'))).toContain('fidelity')
    expect(lines.find((line) => line.startsWith('review-lens'))).not.toContain('fidelity')
  })

  test('every score hint names the ROOT, never the turn it printed after', () => {
    /**
     * `orch result <turn>` printed `score it: orch score <turn>` — the one
     * command score refuses ("run 727 is one turn of run 725"). The first thing
     * the tool showed you was the thing it would not accept. scoreHint had been
     * right all along; two call sites simply did not use it.
     */
    const root = insert('ok', 'implement')
    const turn = insert('ok', 'implement')
    db().query('UPDATE run SET parent_run_id=?, turn=1 WHERE id=?').run(root, turn)
    const r = orch('result', String(turn))
    expect(r.err).toContain(`orch score ${root}`)
    expect(r.err).not.toContain(`orch score ${turn} <`)
    expect(r.err).toContain(`not turn ${turn}`)
  })

  test('result and wait name the branch actually minted for a writing run', () => {
    const id = insert('ok', 'implement')
    const minted = `DEV-436-orch-${id}`
    db().query('UPDATE run SET branch=?, minted_branch=? WHERE id=?')
      .run('stale-dispatch-branch', minted, id)
    const recorded = db().query('SELECT minted_branch FROM run WHERE id=?').get(id) as
      { minted_branch: string }

    const result = orch('result', String(id))
    const wait = orch('wait', String(id))

    expect(result.code).toBe(0)
    expect(wait.code).toBe(0)
    expect(result.err).toContain(recorded.minted_branch)
    expect(wait.out).toContain(recorded.minted_branch)
    expect(result.err).not.toContain('stale-dispatch-branch')
    expect(wait.out).not.toContain('stale-dispatch-branch')
  })

  test('result and wait add no branch detail when the run minted no branch', () => {
    const id = insert('ok', 'file-question')
    db().query('UPDATE run SET branch=?, minted_branch=NULL WHERE id=?')
      .run('read-only-caller-branch', id)

    const result = orch('result', String(id))
    const wait = orch('wait', String(id))

    expect(result.code).toBe(0)
    expect(wait.code).toBe(0)
    expect(result.err).not.toMatch(/^\s*branch:/m)
    expect(wait.out).not.toMatch(/^\s*branch:/m)
    expect(result.err).not.toContain('read-only-caller-branch')
    expect(wait.out).not.toContain('read-only-caller-branch')
  })

  test('a resumed chain reports its owned branch, not the turn branch', () => {
    const root = insert('ok', 'implement')
    const turn = insert('ok', 'implement')
    const owned = `DEV-436-orch-${root}`
    db().query('UPDATE run SET branch=?, minted_branch=? WHERE id=?')
      .run('pre-fix-branch', owned, root)
    db().query(
      'UPDATE run SET parent_run_id=?, turn=2, branch=?, minted_branch=NULL WHERE id=?',
    ).run(root, 'stale-turn-branch', turn)

    const result = orch('result', String(turn))
    const wait = orch('wait', String(root))

    expect(result.code).toBe(0)
    expect(wait.code).toBe(0)
    expect(result.err).toContain(owned)
    expect(wait.out).toContain(owned)
    expect(result.err).not.toContain('stale-turn-branch')
    expect(wait.out).not.toContain('stale-turn-branch')
  })

  test('a leaf id scores the root of its conversation', () => {
    const root = insert('ok', 'implement')
    const turn = insert('ok', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id IN (?,?)')
      .run('orch-test-session', root, turn)
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, turn)

    const r = orch('score', String(turn), 'full', 'right', 'faithful')
    expect(r.code).toBe(0)
    expect(r.out).toContain(`run ${root} (codex/implement) scored full right faithful`)
    expect(db().query('SELECT run_id FROM score').all()).toEqual([{ run_id: root }])
  })

  test('a leaf id answers the open question in its conversation', () => {
    const root = insert('running', 'implement')
    const turn = insert('running', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id IN (?,?)')
      .run('orch-test-session', root, turn)
    db().query('UPDATE run SET parent_run_id=?, turn=2, pid=? WHERE id=?')
      .run(root, process.pid, turn)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(turn, new Date().toISOString(), 'which shape?')

    const r = orch('answer', String(turn), 'the existing shape')
    expect(r.code).toBe(0)
    expect(r.out).toContain('ruled on 1 question(s)')
    expect(db().query('SELECT answer FROM question').get()).toEqual({ answer: 'the existing shape' })
  })

  test('inbox names the canonical root in its answer footer', () => {
    const root = insert('asking', 'implement')
    const turn = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id IN (?,?)')
      .run('orch-test-session', root, turn)
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, turn)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(turn, new Date().toISOString(), 'which shape?')

    const r = orch('inbox')
    expect(r.code).toBe(0)
    expect(r.out).toContain(`rule on them:  orch answer ${root} "<ruling>"`)
    expect(r.out).not.toContain(`rule on them:  orch answer ${turn} "<ruling>"`)
  })

  test('inbox keeps own questions in their existing format outside a registered project', () => {
    const own = insert('asking', 'implement')
    const orphan = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', own)
    db().query('UPDATE run SET session_id=NULL WHERE id=?').run(orphan)
    db().query('INSERT INTO question (run_id, asked_at, question, options, recommendation, why) VALUES (?,?,?,?,?,?)')
      .run(own, new Date().toISOString(), 'own shape?', JSON.stringify(['one', 'two']), 'one', 'it fits')
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(orphan, new Date().toISOString(), 'orphan shape?')

    const r = orch('inbox')
    expect(r.code).toBe(0)
    expect(r.out).toContain(`run ${own} · codex/implement · asking`)
    expect(r.out).toContain('        why: it fits\n        - one\n        - two\n        it would: one')
    expect(r.out).toContain(`rule on them:  orch answer ${own} "<ruling>"`)
    expect(r.out).not.toContain(`run ${orphan}`)
  })

  test('project inbox exposes a foreign question without adopting it', () => {
    const id = insert('asking', 'implement')
    const askedAt = new Date(Date.now() - 90_000).toISOString()
    db().query('UPDATE run SET session_id=?, repo=? WHERE id=?').run('gone-session', 'fixture-repo', id)
    upsertProject({ name: 'fixture-repo', path: realpathSync(dir), settings: {} })
    db().query('INSERT INTO question (run_id, asked_at, question, options, recommendation) VALUES (?,?,?,?,?)')
      .run(id, askedAt, 'which shape?', JSON.stringify(['existing', 'new']), 'existing')

    const r = orchFrom(realpathSync(dir), 'orch-test-session', 'inbox')
    expect(r.code).toBe(0)
    expect(r.out).toContain('visible here, but owned by another session:')
    expect(r.out).toContain(`run ${id} · implement · codex · fixture-repo · owner gone-session · liveness unknown`)
    expect(r.out).toContain('which shape?\n        - existing\n        - new')
    expect(r.out).toContain('recommendation: existing')
    expect(r.out).toContain('only the owning session may rule')
    expect(r.out).not.toContain(`orch answer ${id}`)
  })

  test('project inbox reports a recently-seen foreign owner as live, without authority', () => {
    const id = insert('asking', 'implement')
    upsertProject({ name: 'fixture-repo', path: realpathSync(dir), settings: {} })
    db().query('UPDATE run SET session_id=?, repo=? WHERE id=?')
      .run('other-live-session', 'fixture-repo', id)
    db().query('INSERT INTO session_seen (session_id, last_seen) VALUES (?,?)')
      .run('other-live-session', new Date().toISOString())
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'still owned?')

    const r = orchFrom(realpathSync(dir), 'orch-test-session', 'inbox')
    expect(r.code).toBe(0)
    expect(r.out).toContain('owner other-live-session · liveness live')
    expect(r.out).not.toContain(`orch answer ${id}`)
  })

  test('inbox --all keeps another live session visible but not answerable', () => {
    const id = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('other-live-session', id)
    db().query('INSERT INTO session_seen (session_id, last_seen) VALUES (?,?)')
      .run('other-live-session', new Date().toISOString())
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'still owned?')

    const r = orch('inbox', '--all')
    expect(r.code).toBe(0)
    expect(r.out).toContain(`run ${id} · implement · codex`)
    expect(r.out).toContain('visible here, but owned by another session:')
    expect(r.out).not.toContain(`orch answer ${id}`)
  })

  test('inbox --all shows a foreign recoverable root without offering authority', () => {
    const id = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('other-session', id)

    const r = orch('inbox', '--all')
    expect(r.code).toBe(0)
    expect(r.out).toContain(`run ${id} · codex/implement`)
    expect(r.out).toContain('owner other-session · visible only')
    expect(r.out).toContain('only the owning session may continue it')
    expect(r.out).not.toContain(`recoverable: orch continue ${id}`)

    const continued = orch('continue', String(id), 'continue ownership fixture')
    expect(continued.code).toBe(1)
    expect(continued.err).toContain(`run ${id} is owned by session other-session`)
    expect(continued.err).toContain('current session orch-test-session cannot continue it')
  })

  test('inbox --all --json reports live or unknown without asserting death', () => {
    const live = insert('asking', 'implement')
    const orphan = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('other-live-session', live)
    db().query('UPDATE run SET session_id=NULL WHERE id=?').run(orphan)
    db().query('INSERT INTO session_seen (session_id, last_seen) VALUES (?,?)')
      .run('other-live-session', new Date().toISOString())
    const askedAt = new Date().toISOString()
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(live, askedAt, 'live question')
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(orphan, askedAt, 'orphan question')

    const r = orch('inbox', '--all', '--json')
    expect(r.code).toBe(0)
    const rows = JSON.parse(r.out) as Record<string, unknown>[]
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      question_id: expect.any(Number), run_id: live, answer_id: live,
      job: 'implement', agent: 'codex', repo: null, asked_at: askedAt,
      session_live: true, session_liveness: 'live', can_answer: false,
    })
    expect(rows[1]).toMatchObject({
      run_id: orphan, answer_id: orphan, session_live: null,
      session_liveness: 'unknown', can_answer: true,
    })
  })

  test('inbox treats an empty-string exclusion as voided, matching VOIDED_SQL', () => {
    const id = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=?, evidence_excluded=? WHERE id=?')
      .run('orch-test-session', '', id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'empty exclusion?')

    expect(orch('inbox').out).not.toContain(`run ${id}`)
    const listed = orch('inbox', '--all')
    expect(listed.out).toContain(`run ${id}`)
    expect(listed.out).toContain('voided (terminal)')
    expect(JSON.parse(orch('inbox', '--all', '--json').out)).toContainEqual(
      expect.objectContaining({ run_id: id, status: 'voided', can_answer: false }),
    )
  })

  test('bare inbox scopes visibility by checkout while ownership stays session-scoped', () => {
    // BEFORE: cwd was not a term in the filter, so both invocations rendered
    // both stale-owner questions under the adoptable heading. AFTER: the same
    // database viewed from each registered checkout shows only that project.
    const alphaPath = join(dir, 'alpha-checkout')
    const betaPath = join(dir, 'beta-checkout')
    mkdirSync(alphaPath); mkdirSync(betaPath)
    const alpha = realpathSync(alphaPath)
    const beta = realpathSync(betaPath)
    upsertProject({ name: 'alpha', path: alpha, settings: {} })
    upsertProject({ name: 'beta', path: beta, settings: {} })
    const alphaRun = insert('asking', 'implement')
    const betaRun = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=?, repo=? WHERE id=?')
      .run('alpha-owner', 'alpha', alphaRun)
    db().query('UPDATE run SET session_id=?, repo=? WHERE id=?')
      .run('beta-owner', 'beta', betaRun)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(alphaRun, new Date().toISOString(), 'alpha decision?')
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(betaRun, new Date().toISOString(), 'beta decision?')

    const fromAlpha = orchFrom(alpha, 'reader', 'inbox')
    const fromBeta = orchFrom(beta, 'reader', 'inbox')
    expect(fromAlpha.out).toContain('alpha decision?')
    expect(fromAlpha.out).not.toContain('beta decision?')
    expect(fromBeta.out).toContain('beta decision?')
    expect(fromBeta.out).not.toContain('alpha decision?')
    expect(fromAlpha.out).not.toContain(`orch answer ${alphaRun}`)
    expect(fromBeta.out).not.toContain(`orch answer ${betaRun}`)
  })

  test('answer rejects a fixture ruling from a non-owning session without writing it', () => {
    // BEFORE: answer had no session gate; this exact foreign ruling was written
    // and the worker resumed under an architect who did not own its spec.
    const id = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('owning-session', id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which shape?')

    const r = orch('answer', String(id), 'foreign ruling')
    expect(r.code).toBe(1)
    expect(r.err).toContain(`run ${id} is owned by session owning-session`)
    expect(r.err).toContain('current session orch-test-session cannot answer')
    expect(db().query('SELECT answer, answered_at FROM question WHERE run_id=?').get(id))
      .toEqual({ answer: null, answered_at: null })
  })

  test('answer permits an unowned question, warns, and records the answering session', () => {
    const id = insert('running', 'implement')
    db().query('UPDATE run SET session_id=NULL, pid=? WHERE id=?').run(process.pid, id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which shape?')

    const r = orch('answer', String(id), 'the existing shape')
    expect(r.code).toBe(0)
    expect(r.err).toContain(`run ${id} is unowned`)
    expect(r.err).toContain('session orch-test-session may rule')
    expect(db().query(
      'SELECT answer, answered_by, answered_at FROM question WHERE run_id=?',
    ).get(id)).toEqual({
      answer: 'the existing shape', answered_by: 'orch-test-session',
      answered_at: expect.any(String),
    })
    expect(db().query('SELECT session_id FROM run WHERE id=?').get(id))
      .toEqual({ session_id: 'orch-test-session' })
    expect(db().query(
      'SELECT action, actor_session, reason FROM run_mutation_audit WHERE root_id=? ORDER BY rowid',
    ).all(id)).toEqual([
      { action: 'adopt', actor_session: 'orch-test-session', reason: 'before answer' },
      { action: 'answer', actor_session: 'orch-test-session', reason: null },
    ])
    const foreign = orchInput(['stop', String(id)], undefined, {
      CLAUDE_CODE_SESSION_ID: 'other-session',
    })
    expect(foreign.code).toBe(1)
    expect(foreign.err).toContain(`run ${id} is owned by session orch-test-session`)
  })

  test('a flag value is not mistaken for a run id', () => {
    // `--timeout 300` was read as a fourth run to wait for, and wait duly
    // reported "300 ok" for a run that has never existed.
    const id = insert('ok')
    const r = orch('wait', String(id), '--timeout', '300')
    expect(r.code).toBe(0)
    expect(r.out).toContain(`${id}\tok`)
    expect(r.out).not.toContain('300\t')
  })

  test('waiting on ok and asking runs succeeds and points to the inbox', () => {
    const ok = insert('ok')
    const asking = insert('asking', 'implement')
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(asking, new Date().toISOString(), 'which shape?')
    const r = orch('wait', String(ok), String(asking))
    expect(r.code).toBe(0)
    expect(r.out).toContain(`${ok}\tok`)
    expect(r.out).toContain(`${asking}\tasking`)
    expect(r.out).toContain('orch inbox')
  })

  test('wait names the root, not the asking tip, when a question is open', () => {
    const root = insert('asking', 'implement')
    const turn = insert('asking', 'implement')
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, turn)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(turn, new Date().toISOString(), 'which shape?')

    const r = orch('wait', String(root))
    expect(r.code).toBe(0)
    expect(r.out).toContain(`${root}\tasking - orch inbox (or orch answer ${root})`)
    expect(r.out).not.toContain(`orch answer ${turn}`)
  })

  test('wait keeps waiting when an asking tip has no open question but its root is running', () => {
    const root = insert('running', 'implement')
    const turn = insert('asking', 'implement')
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, root)
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, turn)

    const r = orch('wait', String(root), '--timeout', '0')
    expect(r.code).toBe(2)
    expect(r.err).toContain(`still running after 0s: ${turn}`)
    expect(r.out).not.toContain('asking')
    expect(r.out).not.toContain('orch answer')
  })

  test('wait exposes an asking chain with no open question or running turn as recoverable', () => {
    const root = insert('asking', 'implement')
    const turn = insert('asking', 'implement')
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, turn)

    const r = orch('wait', String(root))
    expect(r.code).toBe(0)
    expect(r.out).toContain(`${root}\tasking - recoverable: orch continue ${root}`)
    expect(r.out).not.toContain(`orch continue ${turn}`)
    expect(r.out).not.toContain('orch answer')
  })

  test('result on an asking run succeeds, prints its reply, and points to the inbox', () => {
    const id = insert('asking', 'implement')
    const output = join(dir, `asking-${id}.txt`)
    writeFileSync(output, 'I need a ruling.')
    db().query('UPDATE run SET output_path=? WHERE id=?').run(output, id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which shape?')
    const r = orch('result', String(id))
    expect(r.code).toBe(0)
    expect(r.out).toContain('I need a ruling.')
    expect(r.err).toContain(`waiting on a ruling: orch answer ${id}`)
  })

  test('inbox marks an answered-but-undelivered chain stranded', () => {
    const root = insert('asking', 'implement')
    const turn = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id IN (?,?)')
      .run('orch-test-session', root, turn)
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, turn)
    db().query(
      `INSERT INTO question
        (run_id, asked_at, question, answer, answered_at, answered_by, delivery_pending_at)
       VALUES (?, ?, 'which shape?', 'existing', ?, 'orch-test-session', ?)`,
    ).run(turn, new Date().toISOString(), new Date().toISOString(), new Date().toISOString())

    const inbox = orch('inbox')
    expect(inbox.code).toBe(0)
    expect(inbox.out).toContain(`asking, but no ruling is open — stranded`)
    expect(inbox.out).toContain(`orch retry ${root} --agent`)
    expect(inbox.out).not.toContain(`recoverable: orch continue ${root}`)

    const result = orch('result', String(turn))
    expect(result.code).toBe(0)
    expect(result.err).toContain(`asking — recoverable: orch continue ${root}`)
    expect(result.err).not.toContain(`orch continue ${turn}`)
  })

  test('inbox and continue refuse recovery while a later chain turn is running', () => {
    const root = insert('asking', 'implement')
    const completed = insert('ok', 'implement')
    const running = insert('running', 'implement')
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, completed)
    db().query('UPDATE run SET parent_run_id=?, turn=3 WHERE id=?').run(root, running)

    const inbox = orch('inbox')
    expect(inbox.code).toBe(0)
    expect(inbox.out).not.toContain(`recoverable: orch continue ${root}`)

    const continued = orch('continue', String(root), 'continue this chain')
    expect(continued.code).toBe(1)
    expect(continued.err).toContain(`run ${root} already has running turn ${running} (turn 3)`)
  })

  test('answer refuses an asking run with no vendor session without recording the ruling', () => {
    const id = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which shape?')

    const result = orch('answer', String(id), 'use the existing shape')

    expect(result.code).toBe(1)
    expect(result.err).toContain(`run ${id} cannot be resumed: no vendor session (agent codex)`)
    expect(result.err).toContain('the ruling was NOT recorded')
    expect(result.err).toContain(`orch retry ${id} --agent`)
    expect(result.err).toContain(`orch abandon ${id}`)
    expect(db().query(
      'SELECT answer, answered_by, answered_at FROM question WHERE run_id=?',
    ).get(id)).toEqual({ answer: null, answered_by: null, answered_at: null })
  })
})
