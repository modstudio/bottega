import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS, GENERIC_QUESTION_TOKENS, addDoctrineRule, addPair, addRun, addSkip, ask, baselineForPair, candidates, db, declaredCreate, detectBlockers, dir, hasRealQuestions, hermeticGitEnv, ledgerRef, listDoctrineRules, listLedgerRefs, listPairs, listSkips, nowIso, parseWorkerReply, parseWorkerReplyWithCount, pick, projects, realQuestions, reapTestRun, removeProject, resolveLedgerRef, retireDoctrineRule, reviewReply, run, runDetail, score, setBaseline, setLedgerRef, state, upsertProject, weigh, workerReply } from '../test/fixture.ts'
import { scriptedTransport, scriptedTransportSequence } from '../test/fake-transport.ts'
import { installTestTransport } from './transport.ts'
import { collectResult } from './collect.ts'; import { trackedTestResidue } from '../test/residue.ts'
const trackResidue = trackedTestResidue(); let priorOrchDepth: string | undefined; beforeEach(() => { priorOrchDepth = process.env.ORCH_DEPTH; trackResidue(join(dir, '.claude')) })
afterEach(() => {
  installTestTransport(null)
  if (priorOrchDepth === undefined) delete process.env.ORCH_DEPTH
  else process.env.ORCH_DEPTH = priorOrchDepth
})
describe('porting data model', () => {
  test('stores pair progress and declined candidates with their reasons', () => {
    upsertProject({ name: 'source-invented', path: '/w/source-invented',
      settings: { keyPrefixes: ['SRC'] } })
    upsertProject({ name: 'target-invented', path: '/w/target-invented',
      settings: { keyPrefixes: ['TGT'] } })
    const [source, target] = projects().sort((a, b) => a.name.localeCompare(b.name))
    const pair = addPair(source!.id, target!.id, '2026-09-01T00:00:00.000Z'); expect(addPair(source!.id, target!.id).id).toBe(pair.id); expect(listPairs()).toEqual([pair]); expect(baselineForPair(pair.id)).toEqual({
      pair_id: pair.id, source_commit: null, scanned_at: null,
    }); expect(setBaseline(pair.id, 'abc123', '2026-09-02T00:00:00.000Z')).toEqual({
      pair_id: pair.id, source_commit: 'abc123', scanned_at: '2026-09-02T00:00:00.000Z',
    })
    addSkip(pair.id, 'candidate-one', 'not applicable', '2026-09-03T00:00:00.000Z'); expect(listSkips(pair.id)).toMatchObject([
      { candidate: 'candidate-one', reason: 'not applicable' },
    ])
  })
  test('keeps each ledger source project distinct and resolves the target by key prefix', () => {
    upsertProject({ name: 'source-one-invented', path: '/w/source-one', settings: {} })
    upsertProject({ name: 'source-two-invented', path: '/w/source-two', settings: {} })
    upsertProject({ name: 'target-invented', path: '/w/target',
      settings: { keyPrefixes: ['TGT'] } })
    const byName = Object.fromEntries(projects().map((project) => [project.name, project]))
    const ref = setLedgerRef({
      taskKey: 'TGT-42', note: 'adapt this natively', createdAt: '2026-09-03T00:00:00.000Z',
      sources: [
        { source_project_id: byName['source-one-invented']!.id,
          commits: ['aaa'], paths: ['src/a.ts'], note: 'first source' },
        { source_project_id: byName['source-two-invented']!.id,
          commits: ['bbb', 'ccc'], paths: ['src/b.ts'], note: 'second source' },
      ],
    }); expect(ref.target_project_id).toBe(byName['target-invented']!.id); expect(ledgerRef('TGT-42')!.sources).toEqual([
      { source_project_id: byName['source-one-invented']!.id,
        commits: ['aaa'], paths: ['src/a.ts'], note: 'first source' },
      { source_project_id: byName['source-two-invented']!.id,
        commits: ['bbb', 'ccc'], paths: ['src/b.ts'], note: 'second source' },
    ]); expect(() => setLedgerRef({ taskKey: 'NONE-1', note: '', sources: ref.sources }))
      .toThrow('no registered project owns task key')
  })
  test('resolution preserves provenance and default listings omit completed refs', () => {
    upsertProject({ name: 'source-invented', path: '/w/source', settings: {} })
    upsertProject({ name: 'target-invented', path: '/w/target',
      settings: { keyPrefixes: ['TGT'] } })
    const source = projects().find((project) => project.name === 'source-invented')!
    setLedgerRef({
      taskKey: 'TGT-42', note: 'provenance',
      sources: [{ source_project_id: source.id, commits: ['abc'], paths: ['src/a.ts'], note: 'source' }],
    }); expect(listLedgerRefs()).toHaveLength(1); expect(resolveLedgerRef('TGT-42', '2026-09-04T00:00:00.000Z')).toMatchObject({
      task_key: 'TGT-42', resolved_at: '2026-09-04T00:00:00.000Z',
      sources: [{ commits: ['abc'], paths: ['src/a.ts'] }],
    }); expect(listLedgerRefs()).toEqual([]); expect(listLedgerRefs(true)).toHaveLength(1); expect(resolveLedgerRef('TGT-42', 'later')?.resolved_at).toBe('2026-09-04T00:00:00.000Z')
  })
  test('retires doctrine without freeing its stable number', () => {
    addDoctrineRule(7, 'Invented rule', 'Keep the example invented.', '2026-09-01T00:00:00.000Z'); expect(retireDoctrineRule(7, '2026-09-02T00:00:00.000Z')).toBe(true); expect(listDoctrineRules(false)).toEqual([]); expect(listDoctrineRules()).toMatchObject([{ number: 7, retired_at: '2026-09-02T00:00:00.000Z' }]); expect(() => addDoctrineRule(7, 'Replacement', 'Must not reuse seven.')).toThrow()
  })
})
describe('agent retry and failover records', () => {
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString()); return result.stdout.toString().trim()
  }
  test('a read-only run stores the caller prompt unwrapped and the bound prompt beside it', async () => {
    const original = 'What does foo.ts do?'; scriptedTransport([{ kind: 'completed', output: 'plain answer' }]).install(); process.env.ORCH_DEPTH = '0'
    const result = await run({ job: 'file-question', prompt: original, cwd: dir, agent: 'codex', noFailover: true })
    const row = db().query('SELECT prompt_path,prompt_sha,spec_sha FROM run WHERE id=?').get(result.id) as { prompt_path: string; prompt_sha: string; spec_sha: string }; expect(readFileSync(row.prompt_path, 'utf8')).toBe(original); const bound = readFileSync(row.prompt_path.replace(/\.prompt\.txt$/, '.bound.txt'), 'utf8'); expect(bound.endsWith(original)).toBe(true); expect(row.prompt_sha).not.toBe(row.spec_sha); expect(runDetail(result.id)?.prompt).toBe(original)
  })
  test('--no-failover holds and records a clear terminal explanation', async () => {
    scriptedTransport([{ kind: 'stderr', chunk: 'usage limit reached' }, { kind: 'completed', exitCode: 1 }]).install(); process.env.ORCH_DEPTH = '0'
    await expect(run({ job: 'understand', prompt: 'do not retry this', agent: 'codex', cwd: dir, noFailover: true })).rejects.toThrow('usage limit reached'); expect(db().query('SELECT no_failover,failure_kind,error FROM run ORDER BY id DESC LIMIT 1').get()).toMatchObject({ no_failover: 1, failure_kind: 'quota', error: expect.stringContaining('Failover refused: disabled by --no-failover') })
  })
  test('prefer persists through automatic failover and the successor returns the answer', async () => {
    scriptedTransportSequence([[{ kind: 'stderr', chunk: 'HTTP 402: balance exhausted' }, { kind: 'completed', exitCode: 1 }], [{ kind: 'completed', output: 'successor answer' }]]).install(); process.env.ORCH_DEPTH = '0'
    const result = await run({ job: 'understand', prompt: 'answer once', agent: 'codex', cwd: dir }); expect(result.output).toBe('successor answer'); const rows = db().query('SELECT agent,retry_of,automatic_failover FROM run ORDER BY id').all(); expect(rows).toEqual([{ agent: 'codex', retry_of: null, automatic_failover: 0 }, { agent: 'grok', retry_of: result.id - 1, automatic_failover: 1 }])
  })
  test('quota failover tries every enabled agent and skips disabled legacy rows', async () => {
    scriptedTransportSequence([[{ kind: 'stderr', chunk: 'HTTP 402: no balance' }, { kind: 'completed', exitCode: 1 }], [{ kind: 'failed', error: 'HTTP 402: no balance' }]]).install(); process.env.ORCH_DEPTH = '0'
    await expect(run({ job: 'review-lens-inline', prompt: 'bounded', agent: 'codex', cwd: dir, lens: 'bounded' })).rejects.toThrow()
    const rows = db().query('SELECT agent,retry_of,error FROM run ORDER BY id').all() as { agent: string; retry_of: number | null; error: string }[]; expect(rows.map((row) => row.agent)).toEqual(['codex', 'grok']); expect(rows[1]!.error).toContain('after trying codex, grok')
  })
  test('a repository review failover keeps its immutable base across a trunk move', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-review-failover-')); const caller = join(repo, '.claude', 'caller')
    try {
      git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.email', 'orch-test@example.invalid'); git(repo, 'config', 'user.name', 'Orch Test'); writeFileSync(join(repo, 'base.txt'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base')
      const originalBase = git(repo, 'rev-parse', 'HEAD'); git(repo, 'worktree', 'add', '-b', 'feature', caller, originalBase); writeFileSync(join(caller, 'change.ts'), 'carried review subject\n'); upsertProject({ name: 'review-failover-project', path: repo })
      const empty = reviewReply(0); empty.provenance.files_covered = []; empty.provenance.commands_run = []
      const clean = reviewReply(0); clean.provenance.files_covered = ['change.ts']; clean.provenance.commands_run = ['git diff -- change.ts']
      const transport = scriptedTransportSequence([[{ kind: 'ask', question: 'pause', why: 'move trunk' }, { kind: 'completed', output: JSON.stringify(empty) }], [{ kind: 'completed', output: JSON.stringify(clean) }]]); transport.install(); process.env.ORCH_DEPTH = '0'
      const pending = run({ job: 'review-lens', prompt: 'review the carried change', cwd: caller, repo: 'review-failover-project', agent: 'codex', lens: 'failover-base', carry: true })
      while (transport.starts() === 0) await Bun.sleep(5)
      writeFileSync(join(repo, 'trunk.txt'), 'moved\n'); git(repo, 'add', 'trunk.txt'); git(repo, 'commit', '-m', 'trunk moves'); transport.injectRuling('continue')
      const result = await pending; expect(result.agent).toBe('grok')
      const rows = db().query("SELECT agent,status,failure_kind,retry_of,base_commit FROM run WHERE repo='review-failover-project' ORDER BY id").all() as { agent: string; status: string; failure_kind: string | null; retry_of: number | null; base_commit: string }[]; expect(rows[0]).toMatchObject({ agent: 'codex', status: 'failed', failure_kind: 'unevidenced', base_commit: originalBase }); expect(rows[1]).toMatchObject({ agent: 'grok', status: 'ok', retry_of: expect.any(Number), base_commit: originalBase }); expect(git(repo, 'rev-parse', 'main')).not.toBe(originalBase)
    } finally { removeProject('review-failover-project'); rmSync(repo, { recursive: true, force: true }) }
  }, 15_000)
  test('a repository review failover bypasses a writing recipe that cannot recreate its base', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-review-failover-no-base-')); const caller = join(repo, '.claude', 'caller'); const invoked = join(repo, 'project-worktree.invoked'); const tool = join(repo, 'project-worktree.ts')
    try {
      git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.email', 'orch-test@example.invalid'); git(repo, 'config', 'user.name', 'Orch Test'); writeFileSync(join(repo, 'base.txt'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base'); const originalBase = git(repo, 'rev-parse', 'HEAD'); git(repo, 'worktree', 'add', '-b', 'feature', caller, originalBase); writeFileSync(join(caller, 'change.ts'), 'carried review subject\n'); upsertProject({ name: 'review-failover-no-base-project', path: repo })
      const empty = reviewReply(0); empty.provenance.files_covered = []; empty.provenance.commands_run = []; const clean = reviewReply(0); clean.provenance.files_covered = ['change.ts']; clean.provenance.commands_run = ['git diff -- change.ts']
      const transport = scriptedTransportSequence([[{ kind: 'ask', question: 'pause', why: 'change recipe' }, { kind: 'completed', output: JSON.stringify(empty) }], [{ kind: 'completed', output: JSON.stringify(clean) }]]); transport.install(); process.env.ORCH_DEPTH = '0'
      const pending = run({ job: 'review-lens', prompt: 'review the carried change', cwd: caller, repo: 'review-failover-no-base-project', agent: 'codex', lens: 'failover-no-base', carry: true, keepTree: true }); while (transport.starts() === 0) await Bun.sleep(5)
      writeFileSync(tool, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(invoked)}, 'invoked')`); upsertProject({ name: 'review-failover-no-base-project', path: repo, settings: { worktree: { create: declaredCreate(process.execPath, [tool, '{branch}']), branch: 'task/{id}' } } }); transport.injectRuling('continue')
      const result = await pending; expect(result).toMatchObject({ agent: 'grok', worktree: { source: 'git' } }); expect(git(result.worktree!.path, 'rev-parse', 'HEAD')).toBe(originalBase); expect(existsSync(invoked)).toBe(false)
      const rows = db().query("SELECT agent,status,failure_kind,retry_of,base_commit,worktree_source FROM run WHERE repo='review-failover-no-base-project' ORDER BY id").all(); expect(rows).toEqual([{ agent: 'codex', status: 'failed', failure_kind: 'unevidenced', retry_of: null, base_commit: originalBase, worktree_source: 'git' }, { agent: 'grok', status: 'ok', failure_kind: null, retry_of: expect.any(Number), base_commit: originalBase, worktree_source: 'git' }])
    } finally { removeProject('review-failover-no-base-project'); rmSync(repo, { recursive: true, force: true }) }
  }, 15_000)
  test('explicit review failover keeps the original ref and resolved tip', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-explicit-review-failover-'))
    try {
      git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.email', 'orch-test@example.invalid'); git(repo, 'config', 'user.name', 'Orch Test'); writeFileSync(join(repo, 'subject.txt'), 'trunk\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'trunk'); git(repo, 'switch', '-c', 'feature/review-failover'); writeFileSync(join(repo, 'subject.txt'), 'reviewed branch\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'branch')
      const tip = git(repo, 'rev-parse', 'HEAD^{commit}'); const tree = git(repo, 'rev-parse', 'HEAD^{tree}'); git(repo, 'switch', 'main'); upsertProject({ name: 'review-failover-fixture', path: repo, settings: { trunk: 'main' } })
      const review = reviewReply(0); review.provenance.files_covered.push('subject.txt'); review.provenance.commands_run.push('git diff main...feature/review-failover -- subject.txt')
      scriptedTransportSequence([[{ kind: 'stderr', chunk: 'HTTP 402: balance exhausted' }, { kind: 'completed', exitCode: 1 }], [{ kind: 'completed', output: JSON.stringify(review) }]]).install(); process.env.ORCH_DEPTH = '0'
      const result = await run({ job: 'review-lens', prompt: 'inspect the requested branch', cwd: repo, agent: 'codex', lens: 'failover-review', review: 'feature/review-failover', keepTree: true })
      const rows = db().query('SELECT agent,retry_of,input_tree,head_commit,review_ref FROM run ORDER BY id').all(); expect(rows[1]).toEqual({ agent: 'grok', retry_of: expect.any(Number), input_tree: tree, head_commit: tip, review_ref: 'feature/review-failover' }); expect(git(result.worktree!.path, 'rev-parse', 'HEAD')).toBe(tip)
    } finally { removeProject('review-failover-fixture'); rmSync(repo, { recursive: true, force: true }) }
  })
  test('a vendor content refusal is recorded distinctly and fails over', async () => {
    const refusal = 'This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.'
    scriptedTransportSequence([[{ kind: 'stderr', chunk: refusal }, { kind: 'completed', exitCode: 1 }], [{ kind: 'completed', output: 'review completed' }]]).install(); process.env.ORCH_DEPTH = '0'
    const result = await run({ job: 'understand', prompt: 'review the defensive guard', agent: 'codex', cwd: dir }); expect(result).toMatchObject({ agent: 'grok', output: 'review completed' })
    const rows = db().query('SELECT agent,status,failure_kind,retry_of FROM run ORDER BY id').all(); expect(rows).toEqual([{ agent: 'codex', status: 'failed', failure_kind: 'content_refusal', retry_of: null }, { agent: 'grok', status: 'ok', failure_kind: null, retry_of: expect.any(Number) }]); expect(candidates('understand').find((item) => item.agent === 'codex')).toMatchObject({ failures: 0, evidence: 0, cooling: null })
  })
  test('records a cancelled result event as a failed run with its error', async () => {
    scriptedTransport([{ kind: 'stdout', chunk: 'Working.\n' }, { kind: 'failed', error: 'cancelled' }]).install(); process.env.ORCH_DEPTH = '0'
    const reserved = addRun({ agent: '(pending)', job: 'file-question', status: 'running' }); await expect(run({ job: 'file-question', prompt: 'hello', cwd: dir, agent: 'grok', reserveId: reserved, noFailover: true })).rejects.toThrow('cancelled')
    const failed = db().query('SELECT status,failure_kind,error,output_path,output_bytes FROM run WHERE id=?').get(reserved) as { status: string; failure_kind: string; error: string; output_path: string; output_bytes: number }; expect(failed).toMatchObject({ status: 'failed', failure_kind: 'other', error: 'cancelled' }); expect(readFileSync(failed.output_path, 'utf8')).toContain('Working.'); expect(failed.output_bytes).toBeGreaterThan(0)
  })
  test('retains and recovers a transcript when an empty result hits the output ceiling', async () => {
    const visible = `DROP-ME-${'x'.repeat(40 * 1024)}-RECOVERED-END`; const transcript = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', text: visible }], stop_reason: 'max_tokens' } }) + '\n'; scriptedTransport([{ kind: 'stdout', chunk: transcript }, { kind: 'completed', parsedText: '', stopReason: 'max_tokens' }]).install(); process.env.ORCH_DEPTH = '0'
    const reserved = addRun({ agent: '(pending)', job: 'file-question', status: 'running' }); await expect(run({ job: 'file-question', prompt: 'recover this report', cwd: dir, agent: 'grok', reserveId: reserved, noFailover: true })).rejects.toThrow('output ceiling')
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
    const plain = await run({ job: 'review-lens', prompt: 'review', cwd: dir, agent: 'codex', mcp: false, lens: 'plain', noFailover: true })
    const requested = await run({ job: 'review-lens', prompt: 'review', cwd: dir, agent: 'codex', mcp: true, lens: 'requested', noFailover: true })
    expect(db().query('SELECT provenance_status FROM run WHERE id=?').get(plain.id)).toEqual({ provenance_status: null })
    expect(db().query('SELECT provenance_status FROM run WHERE id=?').get(requested.id)).toEqual({ provenance_status: 'silent' })
  })
  test('records a trust attempt before a doctor spawn throws', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-trust-attempt-')))
    const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
    git('init', '-b', 'main'); git('config', 'user.email', 'orch-test@example.invalid'); git('config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'tracked'), 'base\n'); writeFileSync(join(repo, '.mcp.json'), '{}\n'); git('add', '.'); git('commit', '-m', 'base')
    const grok = AGENTS.grok!; const original = grok.bin; const fake = join(dir, 'grok-removed-before-doctor')
    writeFileSync(fake, '#!/bin/sh\nprintf "grok 1.0.13\\n"\n'); chmodSync(fake, 0o755)
    const create = join(dir, 'remove-grok-while-cutting.sh')
    writeFileSync(create, `#!/bin/sh\ngit worktree add --detach "$1" "$2" >/dev/null\nrm ${JSON.stringify(fake)}\necho "$1"\n`); chmodSync(create, 0o755)
    upsertProject({ name: 'trust-attempt-project', path: repo, settings: { worktree: { branch: 'orch/{id}', readonly_create: declaredCreate(create, ['{path}', '{base}']) } } })
    grok.bin = fake; process.env.ORCH_DEPTH = '0'
    const before = (db().query('SELECT MAX(id) id FROM run').get() as { id: number | null }).id ?? 0
    try {
      await expect(run({ job: 'review-lens', prompt: 'review', cwd: repo, agent: 'grok', mcp: true, lens: 'trust', noFailover: true })).rejects.toThrow()
      expect(db().query('SELECT mcp_trust_granted,mcp_trust_path FROM run WHERE id>? ORDER BY id LIMIT 1').get(before)).toEqual({ mcp_trust_granted: 1, mcp_trust_path: null })
    } finally { grok.bin = original; rmSync(repo, { recursive: true, force: true }); rmSync(fake, { force: true }); rmSync(create, { force: true }) }
  })
})
describe('reading the verdict off the command line', () => {
  // Mirrors the filter in cli.ts. `orch score 279 none --note "..."` read
  // --note as the quality and rejected the whole thing as incoherent, which is
  // a baffling way to be told about a typo nobody made.
  const VALUE_FLAGS = new Set(['--agent', '--file', '--schema', '--model', '--note',
                               '--job', '--limit', '--port', '--days', '--window'])
  const words = (args: string[]) =>
    args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1] ?? ''))
  test('a note does not get read as the quality', () => {; expect(words(['none', '--note', 'it returned a vendor error'])).toEqual(['none'])
  })
  test('both halves survive a trailing note', () => {; expect(words(['full', 'right', '--note', 'good stuff'])).toEqual(['full', 'right'])
  })
  test('a boolean switch does not eat the word after it', () => {; expect(words(['full', '--quiet', 'right'])).toEqual(['full', 'right'])
  })
})
describe('what the views print beside a percentage', () => {
  test('a failure-only cell has a negative mean, which a bar cannot render', () => {
    // The router is entitled to a negative score. `width:-50%` renders as
    // nothing, with no hint that the cell is bad rather than empty.
    addRun({ agent: 'agy', job: 'craft', status: 'failed' })
    const c = candidates('craft').find((x) => x.agent === 'agy')!; expect(c.score).toBeLessThan(0)
    const pct = Math.round(c.score! * 100); expect(Math.max(0, Math.min(100, pct))).toBe(0)
  })
  test('evidence is what MIN_SAMPLE counts, so it is what a surface must print', () => {
    // One good verdict plus two unjudged failures: the mean is 0 over THREE
    // judgements. A surface printing "0% of 1" beside it is incoherent — a 0%
    // on a single `right` verdict cannot happen.
    score(addRun({ agent: 'agy', job: 'review-lens-inline' }), 'full', 'right')
    addRun({ agent: 'agy', job: 'review-lens-inline', status: 'failed' })
    addRun({ agent: 'agy', job: 'review-lens-inline', status: 'stale' })
    const c = candidates('review-lens-inline').find((x) => x.agent === 'agy')!; expect(c.score).toBe(0); expect(c.scored).toBe(1); expect(c.evidence).toBe(3)
  })
})
describe('probes are excluded from every query that reports', () => {
  test('byRepo leaves calibration traffic out', () => {
    // The rule is stated in AGENTS.md and this was the one aggregate that had
    // no test holding it: byRepo counted probes until it was noticed by eye.
    const real = addRun({ agent: 'grok', job: 'craft' })
    const probe = addRun({ agent: 'grok', job: 'craft', probe: 1 })
    for (const id of [real, probe]) {
      db().query("UPDATE run SET repo='devbox', vendor_tokens=100 WHERE id=?").run(id)
    }
    const rows = state(null).byRepo as { repo: string; runs: number; toks: number }[]
    const devbox = rows.find((r) => r.repo === 'devbox')!; expect(devbox.runs).toBe(1); expect(devbox.toks).toBe(100)
  })
})
describe('run detail', () => {
  test('publishes every field hub reads without publishing the ask credential', () => {
    const id = addRun({ agent: 'grok', job: 'craft', status: 'failed', latency: 1234, probe: 1 })
    const promptPath = trackResidue(join(dir, 'detail-prompt.txt'))
    const outputPath = trackResidue(join(dir, 'detail-output.txt'))
    writeFileSync(promptPath, 'the whole prompt')
    writeFileSync(outputPath, 'the whole reply')
    db().query(
      `UPDATE run SET vendor_tokens=?, failure_kind=?, evidence_excluded=?, error=?,
                      prompt_path=?, output_path=?, run_token=?, doc_revisions=?, canon_sha=? WHERE id=?`,
    ).run(5678, 'timeout', 'not evidence', 'timed out', promptPath, outputPath, 'secret', '[4,9]', 'canon-123', id)
    score(id, 'partial', 'mixed')
    db().query('UPDATE score SET note=? WHERE run_id=?').run('read by hub', id)
    const detail = runDetail(id)!; expect(detail).toMatchObject({
      id, requested_id: id, resolved_from: 'root', root_id: id,
      agent: 'grok', job: 'craft', latency_ms: 1234, vendor_tokens: 5678,
      status: 'failed', failure_kind: 'timeout', probe: 1,
      evidence_excluded: 'not evidence', error: 'timed out',
      doc_revisions: '[4,9]', canon_sha: 'canon-123',
      delivery: 'partial', quality: 'mixed', note: 'read by hub',
      prompt: 'the whole prompt', output: 'the whole reply',
    }); expect(detail).not.toHaveProperty('run_token')
  })
  test('publishes ordered chain audit and renders a missing actor explicitly', () => {
    const root = addRun({ agent: 'codex', job: 'implement' })
    const child = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, child)
    const insertAudit = db().query(
      `INSERT INTO run_mutation_audit (run_id, root_id, action, actor_session, at, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    insertAudit.run(root, root, 'stop', null, '2026-09-05T01:00:00.000Z', null)
    insertAudit.run(child, root, 'continue', 'architect-session', '2026-09-05T02:00:00.000Z', 'ruled'); expect(runDetail(child)!.audit).toEqual([
      { run_id: root, root_id: root, action: 'stop',
        actor_session: 'anonymous (no session id)', at: '2026-09-05T01:00:00.000Z', reason: null },
      { run_id: child, root_id: root, action: 'continue',
        actor_session: 'architect-session', at: '2026-09-05T02:00:00.000Z', reason: 'ruled' },
    ]); expect(runDetail(child)).toMatchObject({
      id: child, requested_id: child, resolved_from: 'turn', root_id: root,
    }); expect(() => insertAudit.run(root, root, 'invented', null, nowIso(), null)).toThrow()
  })
})
/**
 * `orch wait` and `orch result` are the collection half of `--detach`, and
 * another session's fan-out now depends on their exit codes meaning what they
 * say. Driven through the real CLI, because the bugs worth catching here are in
 * argument parsing and process exit status, neither of which a unit call sees.
 */
describe('a repository-reading job gets a disposable writable disk', () => {
  /**
   * One session had seven files of uncommitted review fixes in its
   * checkout. A review lens ran there with --mcp and codex's
   * --approve-for-me implied workspace-write. The tree came back at HEAD, no
   * stash, no commit, nothing in the reflog. The disposable worktree makes that
   * permission safe instead of excluding the agent from the route.
   */
  test('the old caller-checkout MCP exclusion is no longer needed', () => {; expect(pick('review-lens', 'codex', 0, false, null).agent).toBe('codex')
  })
  test('the same agent remains fine without tools', () => {; expect(pick('review-lens', 'codex', 0, false, null).agent).toBe('codex')
  })
})
describe('a worker that stops to ask is not a worker that failed', () => {
  test('an unparseable reply is rejected rather than read as a status', () => {
    // The dangerous direction: treating "no structured reply" as success would
    // record an unverifiable change set as a completed implementation.
    expect(parseWorkerReply('I have finished the work, it all looks good.')).toBeNull(); expect(parseWorkerReply('')).toBeNull()
  })
  test('an unknown status is not silently promoted to done', () => {; expect(parseWorkerReply(JSON.stringify(workerReply({ status: 'partially-done' })))).toBeNull()
  })
  test('the object is recovered from prose and from a fence', () => {
    const fenced = parseWorkerReply(`Here is my report:\n\`\`\`json\n${JSON.stringify(workerReply())}\n\`\`\``); expect(fenced?.status).toBe('done')
    const embedded = parseWorkerReply(`Result: ${JSON.stringify(workerReply({
      status: 'asking', summary: 'need a ruling', questions: null,
    }))} — over to you`); expect(embedded?.status).toBe('asking')
  })
  test('a schema-shaped reply keeps its optional recommendation', () => {
    const r = parseWorkerReply(JSON.stringify(workerReply({
      status: 'asking', summary: 'stopped', questions: [{
        question: 'one table or two?', options: ['one', 'two'], recommendation: 'two', why: null,
      }],
    }))); expect(r?.questions?.[0]?.recommendation).toBe('two')
  })
  test('a status alone is not a worker contract', () => {; expect(parseWorkerReply('{"status":"done"}')).toBeNull()
  })
  test('wrong-typed nested values reject the whole candidate', () => {; expect(parseWorkerReply(JSON.stringify(workerReply({ questions: [{
      question: 'q?', options: null, recommendation: {}, why: null,
    }] })))).toBeNull()
  })
  test('an asking reply keeps every question with text and why', () => {
    const asking = (questions: unknown[]) => parseWorkerReply(JSON.stringify(workerReply({
      status: 'asking', questions,
    }))); expect(hasRealQuestions(asking([{
      question: 'one table or two?', options: null, recommendation: null,
      why: 'the choice changes the migration',
    }]))).toBe(true); expect(hasRealQuestions(asking([{
      question: 'which table?', options: null, recommendation: null, why: '   ',
    }]))).toBe(false)
    for (const why of ['\u200B', '\u2060', '\u00AD', '\u200B\u2060']) {; expect(hasRealQuestions(asking([{
        question: 'one table or two?', options: null, recommendation: null, why,
      }]))).toBe(false)
    }
    for (const token of GENERIC_QUESTION_TOKENS) {; expect(hasRealQuestions(asking([{
        question: token, options: null, recommendation: null, why: 'a claimed reason',
      }]))).toBe(false)
    }
    for (const disguised of ['(placeholder)!', '[TBD]', 'TODO?', '...question...']) {; expect(hasRealQuestions(asking([{
        question: disguised, options: null, recommendation: null, why: 'a claimed reason',
      }]))).toBe(false)
    }; expect(hasRealQuestions(asking([{
      question: '\u200B\u2060', options: null, recommendation: null, why: 'a claimed reason',
    }]))).toBe(false)
    const partial = asking([
      {
        question: 'which table?', options: null, recommendation: null,
        why: 'the schema changes',
      },
      { question: '   ', options: null, recommendation: null, why: 'unknown choice' },
    ]); expect(hasRealQuestions(partial)).toBe(true); expect(realQuestions(partial).map((item) => item.question)).toEqual(['which table?']); expect(hasRealQuestions(parseWorkerReply(JSON.stringify(workerReply({
      status: 'done', questions: [{
        question: 'Which table?', options: null, recommendation: null,
        why: 'the schema changes',
      }],
    }))))).toBe(true)
  })
})
describe('pid stays the worker for the whole run', () => {
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
      const result = await run({
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
      await expect(run({
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
        const result = await run({
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
      await expect(run({
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
    const repo = mkdtempSync(join(tmpdir(), 'orch-361-write-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    writeFileSync(join(repo, 'seed.txt'), 'seed\n')
    git('init', '-b', 'main')
    git('config', 'user.email', 'orch-test@example.invalid')
    git('config', 'user.name', 'Orch Test')
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
          const result = await run({
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
          await run({
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
    const watched = realpathSync(mkdtempSync(join(tmpdir(), 'orch-361-escape-')))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: watched, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    git('init', '-b', 'main')
    git('config', 'user.email', 'orch-test@example.invalid')
    git('config', 'user.name', 'Orch Test')
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
        await run({ job: 'implement', prompt: 'write outside', cwd: watched, agent: 'grok', noFailover: true })
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
describe('the live ask channel always answers', () => {
  test('a live question is answerable through the command, not only in SQL', () => {
    const live = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db().query(
      'INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)',
    ).run(live, new Date().toISOString(), 'which table?')
    const answerable = (id: number) => {
      const r = db().query('SELECT status, parent_run_id FROM run WHERE id = ?').get(id) as
        { status: string; parent_run_id: number | null }
      const open = db().query(
        `SELECT COUNT(*) n FROM question q JOIN run r ON r.id = q.run_id
          WHERE (r.id = ? OR r.parent_run_id = ?) AND q.answered_at IS NULL`,
      ).get(id, id) as { n: number }
      return !r.parent_run_id && open.n > 0 && (r.status === 'running' || r.status === 'asking')
    }; expect(answerable(live)).toBe(true); expect(answerable(addRun({ agent: 'codex', job: 'implement', status: 'running' }))).toBe(false)
  })
  test('a question asked on turn two is answerable from the root', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const child = addRun({ agent: 'codex', job: 'implement', parent: root, turn: 2 })
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(child, new Date().toISOString(), 'and now what?')
    const open = db().query(
      `SELECT q.id FROM question q JOIN run r ON r.id = q.run_id
        WHERE (r.id = ? OR r.parent_run_id = ?) AND q.answered_at IS NULL`,
    ).all(root, root) as { id: number }[]; expect(open.length).toBe(1)
  })
  test('an unanswered question survives the timeout', async () => {
    const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    await ask({ runId: run, question: 'still open', timeoutMs: 50 })
    const open = db().query(
      'SELECT COUNT(*) AS n FROM question WHERE run_id = ? AND answered_at IS NULL',
    ).get(run) as { n: number }; expect(open.n).toBe(1)
  })
})
describe('a worker asking is not a worker blocked', () => {
  test('the old word is accepted and normalised', () => {
    const r = parseWorkerReply(JSON.stringify(workerReply({
      status: 'blocked', summary: 'x', questions: [{
        question: 'q?', options: null, recommendation: null, why: null,
      }],
    }))); expect(r?.status).toBe('asking')
  })
  test('the two vocabularies do not overlap', () => {
    const asking = parseWorkerReply(JSON.stringify(workerReply({ status: 'asking', summary: 'x' }))); expect(asking?.status).toBe('asking'); expect(detectBlockers('Docker access was denied, so I could not run the suite.')).not.toEqual([])
  })
})
describe('asking is a first-class outcome, not a failure', () => {
  test('every status check uses the current vocabulary', () => {
    const wt = readFileSync(new URL('./worktree.ts', import.meta.url).pathname, 'utf8')
    for (const [name, src] of [['worktree.ts', wt]] as const) {
      const bad = src.split('\n').filter((l) =>
        ["'blocked'", '"blocked"'].some((quoted) => l.includes(quoted))
        && !l.includes('o.status') && !l.trim().startsWith('*')
        && !l.trim().startsWith('//')); expect({ [name]: bad }).toEqual({ [name]: [] })
    }
  })
})
describe('a worker that narrates in its own reply shape', () => {
  test('the LAST object wins, not the first and not the span', () => {
    const r = parseWorkerReply([
      workerReply({ summary: 'Starting by reading the canon', files_changed: [] }),
      workerReply({ summary: 'Added the section', files_changed: ['a.ts', 'b.ts'] }),
    ].map((value) => JSON.stringify(value)).join('\n')); expect(r?.summary).toBe('Added the section'); expect(r?.files_changed).toEqual(['a.ts', 'b.ts'])
  })
  test('a brace inside a string is not a brace', () => {
    expect(parseWorkerReply(JSON.stringify(workerReply({ summary: 'uses {curly} braces' })))?.summary).toBe('uses {curly} braces')
  })
  test('a later object that does not validate does not shadow a good one', () => {
    const r = parseWorkerReply(
      `${JSON.stringify(workerReply({ summary: 'real' }))}\n{"note":"trailing object with no status"}`,
    ); expect(r?.summary).toBe('real')
  })
  test('multiple valid contract objects report their count and take the last', () => {
    const parsed = parseWorkerReplyWithCount([
      workerReply({ summary: 'real reply' }),
      workerReply({ summary: 'quoted contract-shaped object' }),
    ].map((value) => JSON.stringify(value)).join('\n')); expect(parsed.reply?.summary).toBe('quoted contract-shaped object'); expect(parsed.contractObjects).toBe(2)
  })
})
