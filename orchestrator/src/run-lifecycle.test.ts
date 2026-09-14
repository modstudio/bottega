import { afterEach, beforeEach, describe, expect, test } from 'bun:test'; import { readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs'; import { join } from 'node:path'; import { cloneRepository, hermeticGitEnv } from '../test/fixtures/git.ts'; import { reviewReply, workerReply } from '../test/fixtures/replies.ts'; import { addRun, dir, reapTestRun, score } from '../test/fixtures/store.ts'; import { declaredCreate } from '../test/fixtures/worktree.ts'; import { AGENTS } from './agents.ts'; import { db } from './db.ts'; import { removeProject, upsertProject } from './projects.ts'
import { candidates } from './route.ts'
import { run as runJob } from './run.ts'
import { weigh } from './score.ts'
import { runDetail } from './serve.ts'
import { scriptedTransport, scriptedTransportSequence } from '../test/fake-transport.ts'
import { installTestTransport } from './transport.ts'
import { collectResult } from './collect.ts'; import { trackedTestResidue } from '../test/residue.ts'
const trackResidue = trackedTestResidue(); let priorOrchDepth: string | undefined; beforeEach(() => { priorOrchDepth = process.env.ORCH_DEPTH; trackResidue(join(dir, '.claude')) })
afterEach(() => {
  installTestTransport(null)
  if (priorOrchDepth === undefined) delete process.env.ORCH_DEPTH
  else process.env.ORCH_DEPTH = priorOrchDepth
})
describe('agent retry and failover records', () => {
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString()); return result.stdout.toString().trim()
  }
  test('a read-only run stores the caller prompt unwrapped and the bound prompt beside it', async () => {
    const original = 'What does foo.ts do?'; scriptedTransport([{ kind: 'completed', output: 'plain answer' }]).install(); process.env.ORCH_DEPTH = '0'
    const result = await runJob({ job: 'file-question', prompt: original, cwd: dir, agent: 'codex', noFailover: true })
    const row = db().query('SELECT prompt_path,prompt_sha,spec_sha FROM run WHERE id=?').get(result.id) as { prompt_path: string; prompt_sha: string; spec_sha: string }; expect(readFileSync(row.prompt_path, 'utf8')).toBe(original); const bound = readFileSync(row.prompt_path.replace(/\.prompt\.txt$/, '.bound.txt'), 'utf8'); expect(bound.endsWith(original)).toBe(true); expect(row.prompt_sha).not.toBe(row.spec_sha); expect(runDetail(result.id)?.prompt).toBe(original)
  })
  test('--no-failover holds and records a clear terminal explanation', async () => {
    scriptedTransport([{ kind: 'stderr', chunk: 'usage limit reached' }, { kind: 'completed', exitCode: 1 }]).install(); process.env.ORCH_DEPTH = '0'
    await expect(runJob({ job: 'understand', prompt: 'do not retry this', agent: 'codex', cwd: dir, noFailover: true })).rejects.toThrow('usage limit reached'); expect(db().query('SELECT no_failover,failure_kind,error FROM run ORDER BY id DESC LIMIT 1').get()).toMatchObject({ no_failover: 1, failure_kind: 'quota', error: expect.stringContaining('Failover refused: disabled by --no-failover') })
  })
  test('prefer persists through automatic failover and the successor returns the answer', async () => {
    scriptedTransportSequence([[{ kind: 'stderr', chunk: 'HTTP 402: balance exhausted' }, { kind: 'completed', exitCode: 1 }], [{ kind: 'completed', output: 'successor answer' }]]).install(); process.env.ORCH_DEPTH = '0'
    const result = await runJob({ job: 'understand', prompt: 'answer once', agent: 'codex', cwd: dir }); expect(result.output).toBe('successor answer'); const rows = db().query('SELECT agent,retry_of,automatic_failover FROM run ORDER BY id').all(); expect(rows).toEqual([{ agent: 'codex', retry_of: null, automatic_failover: 0 }, { agent: 'grok', retry_of: result.id - 1, automatic_failover: 1 }])
  })
  test('quota failover tries every enabled agent and skips disabled legacy rows', async () => {
    scriptedTransportSequence([[{ kind: 'stderr', chunk: 'HTTP 402: no balance' }, { kind: 'completed', exitCode: 1 }], [{ kind: 'failed', error: 'HTTP 402: no balance' }]]).install(); process.env.ORCH_DEPTH = '0'
    await expect(runJob({ job: 'review-lens-inline', prompt: 'bounded', agent: 'codex', cwd: dir, lens: 'bounded' })).rejects.toThrow()
    const rows = db().query('SELECT agent,retry_of,error FROM run ORDER BY id').all() as { agent: string; retry_of: number | null; error: string }[]; expect(rows.map((row) => row.agent)).toEqual(['codex', 'grok']); expect(rows[1]!.error).toContain('after trying codex, grok')
  })
  test('a repository review failover keeps its immutable base across a trunk move', async () => {
    const repo = cloneRepository('orch-review-failover-'); const caller = join(repo, '.claude', 'caller')
    try {
      const originalBase = git(repo, 'rev-parse', 'HEAD'); git(repo, 'worktree', 'add', '-b', 'feature', caller, originalBase); writeFileSync(join(caller, 'change.ts'), 'carried review subject\n'); upsertProject({ name: 'review-failover-project', path: repo })
      const empty = reviewReply(0); empty.provenance.files_covered = []; empty.provenance.commands_run = []
      const clean = reviewReply(0); clean.provenance.files_covered = ['change.ts']; clean.provenance.commands_run = ['git diff -- change.ts']
      const transport = scriptedTransportSequence([[{ kind: 'ask', question: 'pause', why: 'move trunk' }, { kind: 'completed', output: JSON.stringify(empty) }], [{ kind: 'completed', output: JSON.stringify(clean) }]]); transport.install(); process.env.ORCH_DEPTH = '0'
      const pending = runJob({ job: 'review-lens', prompt: 'review the carried change', cwd: caller, repo: 'review-failover-project', agent: 'codex', lens: 'failover-base', carry: true })
      while (transport.starts() === 0) await Bun.sleep(5)
      writeFileSync(join(repo, 'trunk.txt'), 'moved\n'); git(repo, 'add', 'trunk.txt'); git(repo, 'commit', '-m', 'trunk moves'); transport.injectRuling('continue')
      const result = await pending; expect(result.agent).toBe('grok')
      const rows = db().query("SELECT agent,status,failure_kind,retry_of,base_commit FROM run WHERE repo='review-failover-project' ORDER BY id").all() as { agent: string; status: string; failure_kind: string | null; retry_of: number | null; base_commit: string }[]; expect(rows[0]).toMatchObject({ agent: 'codex', status: 'failed', failure_kind: 'unevidenced', base_commit: originalBase }); expect(rows[1]).toMatchObject({ agent: 'grok', status: 'ok', retry_of: expect.any(Number), base_commit: originalBase }); expect(git(repo, 'rev-parse', 'main')).not.toBe(originalBase)
    } finally { removeProject('review-failover-project'); rmSync(repo, { recursive: true, force: true }) }
  }, 15_000)
  test('a repository review failover bypasses a writing recipe that cannot recreate its base', async () => {
    const repo = cloneRepository('orch-review-failover-no-base-'); const caller = join(repo, '.claude', 'caller'); const invoked = join(repo, 'project-worktree.invoked'); const tool = join(repo, 'project-worktree.ts')
    try { const originalBase = git(repo, 'rev-parse', 'HEAD'); git(repo, 'worktree', 'add', '-b', 'feature', caller, originalBase); writeFileSync(join(caller, 'change.ts'), 'carried review subject\n'); upsertProject({ name: 'review-failover-no-base-project', path: repo })
      const empty = reviewReply(0); empty.provenance.files_covered = []; empty.provenance.commands_run = []; const clean = reviewReply(0); clean.provenance.files_covered = ['change.ts']; clean.provenance.commands_run = ['git diff -- change.ts']
      const transport = scriptedTransportSequence([[{ kind: 'ask', question: 'pause', why: 'change recipe' }, { kind: 'completed', output: JSON.stringify(empty) }], [{ kind: 'completed', output: JSON.stringify(clean) }]]); transport.install(); process.env.ORCH_DEPTH = '0'
      const pending = runJob({ job: 'review-lens', prompt: 'review the carried change', cwd: caller, repo: 'review-failover-no-base-project', agent: 'codex', lens: 'failover-no-base', carry: true, keepTree: true }); while (transport.starts() === 0) await Bun.sleep(5)
      writeFileSync(tool, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(invoked)}, 'invoked')`); upsertProject({ name: 'review-failover-no-base-project', path: repo, settings: { worktree: { create: declaredCreate(process.execPath, [tool, '{branch}']), branch: 'task/{id}' } } }); transport.injectRuling('continue')
      const result = await pending; expect(result).toMatchObject({ agent: 'grok', worktree: { source: 'git' } }); expect(git(result.worktree!.path, 'rev-parse', 'HEAD')).toBe(originalBase); expect(existsSync(invoked)).toBe(false)
      const rows = db().query("SELECT agent,status,failure_kind,retry_of,base_commit,worktree_source FROM run WHERE repo='review-failover-no-base-project' ORDER BY id").all(); expect(rows).toEqual([{ agent: 'codex', status: 'failed', failure_kind: 'unevidenced', retry_of: null, base_commit: originalBase, worktree_source: 'git' }, { agent: 'grok', status: 'ok', failure_kind: null, retry_of: expect.any(Number), base_commit: originalBase, worktree_source: 'git' }])
    } finally { removeProject('review-failover-no-base-project'); rmSync(repo, { recursive: true, force: true }) }
  }, 15_000)
  test('explicit review failover keeps the original ref and resolved tip', async () => {
    const repo = cloneRepository('orch-explicit-review-failover-')
    try { writeFileSync(join(repo, 'subject.txt'), 'trunk\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'trunk'); git(repo, 'switch', '-c', 'feature/review-failover'); writeFileSync(join(repo, 'subject.txt'), 'reviewed branch\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'branch')
      const tip = git(repo, 'rev-parse', 'HEAD^{commit}'); const tree = git(repo, 'rev-parse', 'HEAD^{tree}'); git(repo, 'switch', 'main'); upsertProject({ name: 'review-failover-fixture', path: repo, settings: { trunk: 'main' } })
      const review = reviewReply(0); review.provenance.files_covered.push('subject.txt'); review.provenance.commands_run.push('git diff main...feature/review-failover -- subject.txt')
      scriptedTransportSequence([[{ kind: 'stderr', chunk: 'HTTP 402: balance exhausted' }, { kind: 'completed', exitCode: 1 }], [{ kind: 'completed', output: JSON.stringify(review) }]]).install(); process.env.ORCH_DEPTH = '0'
      const result = await runJob({ job: 'review-lens', prompt: 'inspect the requested branch', cwd: repo, agent: 'codex', lens: 'failover-review', review: 'feature/review-failover', keepTree: true })
      const rows = db().query('SELECT agent,retry_of,input_tree,head_commit,review_ref FROM run ORDER BY id').all(); expect(rows[1]).toEqual({ agent: 'grok', retry_of: expect.any(Number), input_tree: tree, head_commit: tip, review_ref: 'feature/review-failover' }); expect(git(result.worktree!.path, 'rev-parse', 'HEAD')).toBe(tip)
    } finally { removeProject('review-failover-fixture'); rmSync(repo, { recursive: true, force: true }) }
  })
  test('a vendor content refusal is recorded distinctly and fails over', async () => {
    const refusal = 'This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.'
    scriptedTransportSequence([[{ kind: 'stderr', chunk: refusal }, { kind: 'completed', exitCode: 1 }], [{ kind: 'completed', output: 'review completed' }]]).install(); process.env.ORCH_DEPTH = '0'
    const result = await runJob({ job: 'understand', prompt: 'review the defensive guard', agent: 'codex', cwd: dir }); expect(result).toMatchObject({ agent: 'grok', output: 'review completed' })
    const rows = db().query('SELECT agent,status,failure_kind,retry_of FROM run ORDER BY id').all(); expect(rows).toEqual([{ agent: 'codex', status: 'failed', failure_kind: 'content_refusal', retry_of: null }, { agent: 'grok', status: 'ok', failure_kind: null, retry_of: expect.any(Number) }]); expect(candidates('understand').find((item) => item.agent === 'codex')).toMatchObject({ failures: 0, evidence: 0, cooling: null })
  })
  test('records a cancelled result event as a failed run with its error', async () => {
    scriptedTransport([{ kind: 'stdout', chunk: 'Working.\n' }, { kind: 'failed', error: 'cancelled' }]).install(); process.env.ORCH_DEPTH = '0'
    const reserved = addRun({ agent: '(pending)', job: 'file-question', status: 'running' }); await expect(runJob({ job: 'file-question', prompt: 'hello', cwd: dir, agent: 'grok', reserveId: reserved, noFailover: true })).rejects.toThrow('cancelled')
    const failed = db().query('SELECT status,failure_kind,error,output_path,output_bytes FROM run WHERE id=?').get(reserved) as { status: string; failure_kind: string; error: string; output_path: string; output_bytes: number }; expect(failed).toMatchObject({ status: 'failed', failure_kind: 'other', error: 'cancelled' }); expect(readFileSync(failed.output_path, 'utf8')).toContain('Working.'); expect(failed.output_bytes).toBeGreaterThan(0)
  })
  test('retains and recovers a transcript when an empty result hits the output ceiling', async () => {
    const visible = `DROP-ME-${'x'.repeat(40 * 1024)}-RECOVERED-END`; const transcript = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', text: visible }], stop_reason: 'max_tokens' } }) + '\n'; scriptedTransport([{ kind: 'stdout', chunk: transcript }, { kind: 'completed', parsedText: '', stopReason: 'max_tokens' }]).install(); process.env.ORCH_DEPTH = '0'
    const reserved = addRun({ agent: '(pending)', job: 'file-question', status: 'running' }); await expect(runJob({ job: 'file-question', prompt: 'recover this report', cwd: dir, agent: 'grok', reserveId: reserved, noFailover: true })).rejects.toThrow('output ceiling')
    const row = db().query('SELECT status,failure_kind,output_path,output_bytes FROM run WHERE id=?').get(reserved) as { status: string; failure_kind: string; output_path: string; output_bytes: number }; expect(row).toMatchObject({ status: 'failed', failure_kind: 'truncated' }); expect(readFileSync(row.output_path, 'utf8')).toContain('RECOVERED-END')
    const logs: string[] = []; expect(() => collectResult(db(), ['result', String(reserved)], () => '', { log: (...values) => logs.push(values.join(' ')), error: () => {}, exit: (code): never => { throw new Error(`EXIT:${code}`) } })).toThrow('EXIT:1')
    const recovered = logs.join('\n'); expect(recovered).toStartWith('TRUNCATED at the output ceiling'); expect(recovered).toContain('RECOVERED-END'); expect(recovered).not.toContain('DROP-ME')
  })
})

describe('review MCP recording', () => {
  test('silent provenance requires requested MCP degradation', async () => {
    const reply = reviewReply(1)
    scriptedTransportSequence([
      [{ kind: 'completed', output: JSON.stringify(reply) }],
      [{ kind: 'completed', output: JSON.stringify(reply) }],
    ]).install(); process.env.ORCH_DEPTH = '0'
    upsertProject({ name: 'fixture-project', path: dir, settings: {} })
    const plain = await runJob({ job: 'review-lens', prompt: 'review', cwd: dir, agent: 'codex', mcp: false, lens: 'plain', noFailover: true })
    const requested = await runJob({ job: 'review-lens', prompt: 'review', cwd: dir, agent: 'codex', mcp: true, lens: 'requested', noFailover: true })
    expect(db().query('SELECT provenance_status FROM run WHERE id=?').get(plain.id)).toEqual({ provenance_status: null })
    expect(db().query('SELECT provenance_status FROM run WHERE id=?').get(requested.id)).toEqual({ provenance_status: 'silent' })
  })
  test('records a trust attempt before a doctor spawn throws', async () => {
    const repo = cloneRepository('orch-trust-attempt-')
    const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
    writeFileSync(join(repo, 'tracked'), 'base\n'); writeFileSync(join(repo, '.mcp.json'), '{}\n'); git('add', '.'); git('commit', '-m', 'base')
    const grok = AGENTS.grok!; const original = grok.bin; const fake = join(dir, 'grok-removed-before-doctor')
    writeFileSync(fake, '#!/bin/sh\nprintf "grok 1.0.13\\n"\n'); chmodSync(fake, 0o755)
    const create = join(dir, 'remove-grok-while-cutting.sh')
    writeFileSync(create, `#!/bin/sh\ngit worktree add --detach "$1" "$2" >/dev/null\nrm ${JSON.stringify(fake)}\necho "$1"\n`); chmodSync(create, 0o755)
    upsertProject({ name: 'trust-attempt-project', path: repo, settings: { worktree: { branch: 'orch/{id}', readonly_create: declaredCreate(create, ['{path}', '{base}']) } } })
    grok.bin = fake; process.env.ORCH_DEPTH = '0'
    const before = (db().query('SELECT MAX(id) id FROM run').get() as { id: number | null }).id ?? 0
    try {
      await expect(runJob({ job: 'review-lens', prompt: 'review', cwd: repo, agent: 'grok', mcp: true, lens: 'trust', noFailover: true })).rejects.toThrow()
      expect(db().query('SELECT mcp_trust_granted,mcp_trust_path FROM run WHERE id>? ORDER BY id LIMIT 1').get(before)).toEqual({ mcp_trust_granted: 1, mcp_trust_path: null })
    } finally { grok.bin = original; rmSync(repo, { recursive: true, force: true }); rmSync(fake, { force: true }); rmSync(create, { force: true }) }
  })
})

describe('a wall kill does not erase a read-only answer', () => {
  test('substantive output is judgeable and routing does not count it as delivery-none', async () => {
    const script = trackResidue(join(dir, 'DEV-235-readonly-agent.ts'))
    const ready = trackResidue(join(dir, 'DEV-235-readonly-agent-ready'))
    writeFileSync(script, `#!/usr/bin/env bun
process.on('SIGTERM', () => process.exit(143))
process.stdout.write('The requested implementation is in orchestrator/src/run.ts:1542.\\n')
await Bun.write(${JSON.stringify(ready)}, 'ready\\n')
setInterval(() => {}, 1_000)
`)
    chmodSync(script, 0o755)
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const previousTimeout = Object.getOwnPropertyDescriptor(grok, 'timeoutMs')!
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    let runId: number | null = null
    try {
      grok.bin = script
      // The job bound is now compiled into the prompt before launch. Keep this
      // fixture's forced wall kill declarative instead of making timeoutMs a
      // readiness barrier whose getter cannot be read until after launch.
      grok.timeoutMs = 3 * 598
      const result = await runJob({
        job: 'file-question', prompt: 'where is the implementation?', cwd: dir,
        agent: 'grok', noFailover: true,
      })
      runId = result.id
      const row = db().query(
        'SELECT status, failure_kind, exit_code, output_bytes FROM run WHERE id=?',
      ).get(result.id) as {
        status: string; failure_kind: string | null; exit_code: number; output_bytes: number
      }; expect(existsSync(ready)).toBe(true); expect(row).toMatchObject({ status: 'ok', failure_kind: null, exit_code: 143 }); expect(row.output_bytes).toBeGreaterThan(0)
      // Before DEV-235 the rescue required contract?.status === 'done'. A
      // read-only run has no worker contract, so this exact row was failed and
      // candidates() immediately counted it as an implicit delivery=none.
      let candidate = candidates('file-question').find((entry) => entry.agent === 'grok')!; expect(candidate).toMatchObject({ runs: 1, scored: 0, failures: 0, evidence: 0 }); expect(candidate.score).toBeNull()
      score(result.id, 'full', 'right')
      candidate = candidates('file-question').find((entry) => entry.agent === 'grok')!; expect(candidate).toMatchObject({ runs: 1, scored: 1, failures: 0, evidence: 1 }); expect(candidate.score).toBe(weigh('full', 'right'))
    } finally {
      grok.bin = previousBin
      Object.defineProperty(grok, 'timeoutMs', previousTimeout)
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      await reapTestRun(runId)
    }
  })
})

describe('vendor termination markers', () => {
  const grokStream = (...lines: string[]) => `${lines.join('\n')}\n`
  async function withGrokBin<T>(output: string, exitCode: number, fn: () => Promise<T>): Promise<T> {
    const script = trackResidue(join(dir, `DEV-361-agent-${Bun.hash(`${output}:${exitCode}`).toString(16)}.ts`))
    writeFileSync(script,
      `#!/usr/bin/env bun\nprocess.stdout.write(${JSON.stringify(output)})\nprocess.exit(${exitCode})\n`)
    chmodSync(script, 0o755)
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      grok.bin = script
      return await fn()
    } finally {
      grok.bin = previousBin
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  }
  test.each([
    ['NDJSON result plus trailing marker', grokStream(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'a' }),
      JSON.stringify({ type: 'result', result: 'I inspected the files.' }),
      '[API Error: terminated]',
    ), 0],
    ['NDJSON result plus trailing marker at exit 1', grokStream(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'a1' }),
      JSON.stringify({ type: 'result', result: 'I inspected the files.' }),
      '[API Error: terminated]',
    ), 1],
    ['NDJSON with trailing marker and no result', grokStream(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'b' }),
      '[API Error: terminated]',
    ), 0],
    ['output that is only the marker', '[API Error: terminated]\n', 0],
    ['output that is only the marker at exit 1', '[API Error: terminated]\n', 1],
    ['marker with trailing spaces and tabs', '[API Error: terminated]  \t\n', 0],
    ['marker with trailing spaces and tabs at exit 1', '[API Error: terminated]  \t\n', 1],
    ['marker with CRLF', '[API Error: terminated]\r\n', 0],
    ['marker with CRLF at exit 1', '[API Error: terminated]\r\n', 1],
    ['plain text followed by the marker', grokStream(
      'I will inspect the requested files first.',
      '[API Error: terminated]',
    ), 0],
  ])('records failed/truncated for %s', async (_case, output, exitCode) => {
    await withGrokBin(output, exitCode, async () => {
      const reserved = addRun({ agent: '(pending)', job: 'file-question', status: 'running' })
      await expect(runJob({
        job: 'file-question', prompt: 'inspect this', cwd: dir,
        agent: 'grok', reserveId: reserved, noFailover: true,
      })).rejects.toThrow('[API Error: terminated]'); expect(db().query(
        'SELECT status, failure_kind, error, exit_code FROM run WHERE id=?',
      ).get(reserved)).toEqual({
        status: 'failed', failure_kind: 'truncated',
        error: expect.stringContaining('[API Error: terminated]'), exit_code: exitCode,
      }); expect(candidates('file-question').find((candidate) => candidate.agent === 'grok'))
        .toMatchObject({ evidence: 0 })
    })
  })
  test.each([
    ['ordinary output', 'The requested handler returns the stored result after validation.', 0],
    ['ordinary output at exit 1', 'The requested handler returns the stored result after validation.', 1],
    ['API error mentioned in prose', 'The handler swallows [API Error: terminated] instead of returning it.', 0],
    ['API error mentioned in prose at exit 1', 'The handler swallows [API Error: terminated] instead of returning it.', 1],
    ['quoted trailing marker', 'The answer is complete.\n"[API Error: terminated]"\n', 0],
    ['quoted trailing marker at exit 1', 'The answer is complete.\n"[API Error: terminated]"\n', 1],
    ['marker inside a closed code fence', 'The answer is complete.\n```\n[API Error: terminated]\n```\n', 0],
    ['marker inside a closed code fence at exit 1', 'The answer is complete.\n```\n[API Error: terminated]\n```\n', 1],
  ])('does not classify %s as truncated', async (_case, output, exitCode) => {
    await withGrokBin(output, exitCode, async () => {
      let runId: number
      try {
        const result = await runJob({
          job: 'file-question', prompt: 'answer this', cwd: dir,
          agent: 'grok', noFailover: true,
        })
        runId = result.id
      } catch (error) {
        runId = (error as Error & { runId: number }).runId
      }; expect(db().query(
        'SELECT status, failure_kind, error, exit_code FROM run WHERE id=?',
      ).get(runId)).toMatchObject(exitCode === 0
        ? { status: 'ok', failure_kind: null, error: null, exit_code: 0 }
        : { status: 'failed', failure_kind: 'other', exit_code: 1 })
    })
  })
  async function withHangingGrokBin<T>(output: string, fn: (ready: string) => Promise<T>): Promise<T> {
    const script = trackResidue(join(dir, `DEV-361-hang-${Bun.hash(output).toString(16)}.ts`))
    const ready = trackResidue(`${script}.ready`)
    writeFileSync(script, `#!/usr/bin/env bun
process.on('SIGTERM', () => process.exit(143))
process.stdout.write(${JSON.stringify(output)})
await Bun.write(${JSON.stringify(ready)}, 'ready\\n')
setInterval(() => {}, 1_000)
`)
    chmodSync(script, 0o755)
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const previousTimeout = Object.getOwnPropertyDescriptor(grok, 'timeoutMs')!
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      grok.bin = script
      grok.timeoutMs = 3 * 598
      return await fn(ready)
    } finally {
      grok.bin = previousBin
      Object.defineProperty(grok, 'timeoutMs', previousTimeout)
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  }
  test.each([
    ['marker after a complete NDJSON result, killed by our timer', grokStream(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'wall-a' }),
      JSON.stringify({ type: 'result', result: 'I inspected the files.' }),
      '[API Error: terminated]',
    )],
    ['marker alone, killed by our timer', '[API Error: terminated]\n'],
  ])('records failed/truncated for %s', async (_case, output) => {
    await withHangingGrokBin(output, async (ready) => {
      const reserved = addRun({ agent: '(pending)', job: 'file-question', status: 'running' })
      try {
      await expect(runJob({
        job: 'file-question', prompt: 'inspect this', cwd: dir,
        agent: 'grok', reserveId: reserved, noFailover: true,
      })).rejects.toThrow('[API Error: terminated]'); expect(existsSync(ready)).toBe(true); expect(db().query(
        'SELECT status, failure_kind, error, exit_code FROM run WHERE id=?',
      ).get(reserved)).toEqual({
        status: 'failed', failure_kind: 'truncated',
        error: expect.stringContaining('[API Error: terminated]'), exit_code: 143,
      }); expect(candidates('file-question').find((candidate) => candidate.agent === 'grok'))
        .toMatchObject({ evidence: 0 })
      } finally {
        await reapTestRun(reserved)
      }
    })
  })
  const askingContract = JSON.stringify(workerReply({
    status: 'asking', files_changed: null, tests: null,
    questions: [{
      question: 'one table or two?', options: ['one', 'two'], recommendation: 'two',
      why: 'the choice changes the public query shape',
    }],
  }))
  const emptyDoneContract = JSON.stringify(workerReply({
    files_changed: [], tests: { command: null, ran: false, passed: null, detail: null },
  }))
  async function withWritingRepo<T>(fn: (repo: string) => Promise<T>): Promise<T> {
    const repo = cloneRepository('orch-361-write-')
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    writeFileSync(join(repo, 'seed.txt'), 'seed\n')
    git('add', 'seed.txt')
    git('commit', '-m', 'seed')
    try {
      return await fn(repo)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }
  test('a grok asking contract trailing the marker is truncated, not asking, and creates no inbox question', async () => {
    const output = grokStream(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'ask-marker' }),
      JSON.stringify({ type: 'result', result: askingContract }),
      '[API Error: terminated]',
    )
    await withGrokBin(output, 0, async () => {
      await withWritingRepo(async (repo) => {
        let runId: number | null = null
        try {
          const result = await runJob({
            job: 'implement', prompt: 'build it', cwd: repo,
            agent: 'grok', noFailover: true,
          })
          runId = result.id
        } catch (error) {
          runId = (error as Error & { runId?: number }).runId ?? null
        }; expect(runId).not.toBeNull(); expect(db().query(
          'SELECT status, failure_kind FROM run WHERE id=?',
        ).get(runId!)).toEqual({ status: 'failed', failure_kind: 'truncated' }); expect((db().query('SELECT COUNT(*) n FROM question WHERE run_id=?').get(runId!) as { n: number }).n)
          .toBe(0); expect(candidates('implement').find((candidate) => candidate.agent === 'grok'))
          .toMatchObject({ evidence: 0 })
      })
    })
  })
  test('a grok empty-done contract trailing the marker is truncated, not other', async () => {
    const output = grokStream(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'empty-done-marker' }),
      JSON.stringify({ type: 'result', result: emptyDoneContract }),
      '[API Error: terminated]',
    )
    await withGrokBin(output, 0, async () => {
      await withWritingRepo(async (repo) => {
        let runId: number | null = null
        try {
          await runJob({
            job: 'implement', prompt: 'build it', cwd: repo,
            agent: 'grok', noFailover: true,
          })
        } catch (error) {
          runId = (error as Error & { runId?: number }).runId ?? null
        }; expect(runId).not.toBeNull()
        const row = db().query(
          'SELECT status, failure_kind, error FROM run WHERE id=?',
        ).get(runId!) as { status: string; failure_kind: string; error: string }; expect(row).toEqual({
          status: 'failed', failure_kind: 'truncated',
          error: expect.stringContaining('[API Error: terminated]'),
        }); expect(row.failure_kind).not.toBe('other'); expect(row.error).not.toBe('reported done with no change and no test run'); expect(candidates('implement').find((candidate) => candidate.agent === 'grok'))
          .toMatchObject({ evidence: 0 })
      })
    })
  })
  test('a confinement trip with the marker present records escaped, not truncated', async () => {
    const watched = cloneRepository('orch-361-escape-')
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: watched, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    writeFileSync(join(watched, 'tracked.txt'), 'base\n')
    git('add', 'tracked.txt')
    git('commit', '-m', 'fixture')
    const script = trackResidue(join(dir, 'DEV-361-escape-marker.sh'))
    writeFileSync(script, `#!/bin/sh
if [ -n "$ORCH_TEST_EXTERNAL_WRITE" ]; then printf 'outside\\n' > "$ORCH_TEST_EXTERNAL_WRITE"; fi
printf 'inside\\n' > tracked.txt
printf '%s\\n' '{"type":"system","subtype":"init"}' '{"type":"result","result":"answer"}' '[API Error: terminated]'
`)
    chmodSync(script, 0o755)
    upsertProject({ name: 'watched-marker-project', path: watched })
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    const priorTarget = process.env.ORCH_TEST_EXTERNAL_WRITE
    process.env.ORCH_DEPTH = '0'
    try {
      grok.bin = script
      process.env.ORCH_TEST_EXTERNAL_WRITE = join(watched, 'tracked.txt')
      let runId: number | null = null
      try {
        await runJob({ job: 'implement', prompt: 'write outside', cwd: watched, agent: 'grok', noFailover: true })
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }; expect(runId).not.toBeNull()
      const row = db().query(
        'SELECT status, failure_kind FROM run WHERE id=?',
      ).get(runId!) as { status: string; failure_kind: string }; expect(row.status).toBe('failed'); expect(['escaped', 'confinement_unverified']).toContain(row.failure_kind); expect(row.failure_kind).not.toBe('truncated')
    } finally {
      grok.bin = previousBin
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      if (priorTarget === undefined) delete process.env.ORCH_TEST_EXTERNAL_WRITE
      else process.env.ORCH_TEST_EXTERNAL_WRITE = priorTarget
      rmSync(watched, { recursive: true, force: true })
    }
  })
})
