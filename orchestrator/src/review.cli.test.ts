import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, realpathSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { AGENTS, JOBS, MIN_REVIEW_TRIAGED, REVIEW_SCHEMA, VERIFY_CLAIM_SCHEMA, addRun, calibrationLine, cleanReviewEvidence, completeReview, contentTree, coverageAudit, db, dir, getReview, gradeReviewLens, hermeticGitEnv, listReviews, parseReviewReply, preflight, recordReview, recordReviews, removeProject, reviewCalibration, reviewCalibrationFleet, reviewReply, runJob, state, strictCodexSchema, triageFinding, upsertProject } from '../test/fixture.ts'

describe('review discipline', () => {
  test('clean review evidence must name work and intersect the measured change', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-review-evidence-')))
    const gg = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    gg('init', '-b', 'main'); gg('config', 'user.email', 'orch-test@example.invalid')
    gg('config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'base.txt'), 'base\n'); gg('add', '.'); gg('commit', '-m', 'base')
    const base = gg('rev-parse', 'HEAD')
    mkdirSync(join(repo, 'orchestrator', 'src'), { recursive: true })
    mkdirSync(join(repo, 'hub', 'src'), { recursive: true })
    mkdirSync(join(repo, 'dir with space'), { recursive: true })
    mkdirSync(join(repo, 'hyphenated-dir'), { recursive: true })
    writeFileSync(join(repo, 'orchestrator', 'src', 'x.ts'), 'changed\n')
    writeFileSync(join(repo, 'hub', 'src', 'x.ts'), 'also changed\n')
    writeFileSync(join(repo, 'dir with space', 'file.ts'), 'spaced path\n')
    writeFileSync(join(repo, 'hyphenated-dir', 'file-name.ts'), 'hyphenated path\n')
    gg('add', '.'); gg('commit', '-m', 'change')
    const tree = gg('rev-parse', 'HEAD^{tree}')
    upsertProject({ name: 'review-evidence-project', path: repo })
    const runId = addRun({ agent: 'codex', job: 'review-lens', repo: 'review-evidence-project' })
    db().query('UPDATE run SET base_commit=?, input_tree=? WHERE id=?').run(base, tree, runId)
    try {
      const reply = reviewReply(0) as any
      reply.provenance.files_covered = []
      reply.provenance.commands_run = []
      expect(cleanReviewEvidence(runId, reply)).toEqual({
        failure: 'clean review with no evidence: files_covered and commands_run are empty', note: null,
      })

      reply.provenance.commands_run = ['bun test']
      for (const [path, normalized] of ([
        ['orchestrator/src/x.ts', 'orchestrator/src/x.ts'],
        ['./orchestrator/src/x.ts', 'orchestrator/src/x.ts'],
        ['src/x.ts', 'src/x.ts'],
        ['orchestrator/src/x.ts:12', 'orchestrator/src/x.ts'],
        ['orchestrator/src/x.ts:1-4 — inspected changed behavior', 'orchestrator/src/x.ts'],
        ['orchestrator/src/x.ts - inspected changed behavior', 'orchestrator/src/x.ts'],
        ['dir with space/file.ts:12 — inspected changed behavior', 'dir with space/file.ts'],
        ['hyphenated-dir/file-name.ts:3-8 - inspected changed behavior', 'hyphenated-dir/file-name.ts'],
      ] as const)) {
        reply.provenance.files_covered = [path]
        expect(cleanReviewEvidence(runId, reply)).toEqual({ failure: null, note: null })
        expect(reply.provenance.files_covered).toEqual([normalized])
      }

      reply.provenance.files_covered = ['base.txt']
      expect(cleanReviewEvidence(runId, reply).failure).toContain('intersects none')

      const segmentBase = gg('rev-parse', 'HEAD')
      mkdirSync(join(repo, 'foo'), { recursive: true })
      writeFileSync(join(repo, 'foo', 'bar-x.ts'), 'segment boundary\n')
      gg('add', '.'); gg('commit', '-m', 'segment boundary')
      db().query('UPDATE run SET base_commit=?, input_tree=? WHERE id=?')
        .run(segmentBase, gg('rev-parse', 'HEAD^{tree}'), runId)
      reply.provenance.files_covered = ['x.ts']
      expect(cleanReviewEvidence(runId, reply).failure).toContain('intersects none')

      db().query('UPDATE run SET input_tree=NULL WHERE id=?').run(runId)
      const unknown = cleanReviewEvidence(runId, reply)
      expect(unknown.failure).toBeNull()
      expect(unknown.note).toContain('changed-path coverage not checked')

    } finally {
      removeProject('review-evidence-project')
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('list and show expose open, complete, stale, findings, grading, and pin state', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-review-read-'))
    const gg = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], { cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      gg('init', '-b', 'main'); gg('config', 'user.email', 'orch-test@example.invalid'); gg('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'base.txt'), 'base\n'); gg('add', '.'); gg('commit', '-m', 'base')
      gg('checkout', '-b', 'reviewed'); writeFileSync(join(repo, 'change.txt'), 'one\n'); gg('add', '.'); gg('commit', '-m', 'change')
      const project = 'review-read-project'
      upsertProject({ name: project, path: repo, settings: { trunk: 'main' } })
      const make = (lens: string, findings: number) => {
        const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'model-a', lens, repo: project,
          inputTree: gg('rev-parse', 'reviewed^{tree}'), headCommit: gg('rev-parse', 'reviewed') })
        db().query('UPDATE run SET branch=?, base_commit=? WHERE id=?').run('reviewed', gg('rev-parse', 'main'), runId)
        return { runId, reviewId: recordReview(runId, reviewReply(findings)) }
      }
      const open = make('read-open', 1)
      gradeReviewLens(open.runId, null, { reproduced: 'all', coverage: 'adequate', limits: 'named', overlap: 'alone' })
      const complete = make('read-complete', 1); triageFinding(complete.reviewId, 1, 'accepted'); completeReview(complete.reviewId)
      const stale = make('read-stale', 0); completeReview(stale.reviewId)
      db().query('UPDATE review SET recorded_at=? WHERE id=?').run('2026-01-03T00:00:00.000Z', open.reviewId)
      db().query('UPDATE review SET recorded_at=? WHERE id=?').run('2026-01-02T00:00:00.000Z', complete.reviewId)
      db().query('UPDATE review SET recorded_at=? WHERE id=?').run('2026-01-01T00:00:00.000Z', stale.reviewId)

      let rows = listReviews({ project })
      expect(rows.map((row) => row.id)).toEqual([open.reviewId, complete.reviewId, stale.reviewId])
      expect(rows[0]).toMatchObject({ project, branches: ['reviewed'], lens_count: 1,
        findings: { total: 1, triaged: 0, accepted: 0, modified: 0, rejected: 0, skipped: 0 }, coverage: 'exact' })
      expect(listReviews({ state: 'open', project }).map((row) => row.id)).toEqual([open.reviewId])
      expect(listReviews({ state: 'complete', since: '2026-01-02T00:00:00.000Z', project }).map((row) => row.id))
        .toEqual([complete.reviewId])
      const cli = (...args: string[]) => Bun.spawnSync(
        [process.execPath, new URL('cli.ts', import.meta.url).pathname, 'review', 'list', '--project', project, ...args],
        { env: { ...process.env, ORCH_DEPTH: '0', GIT_OBJECT_DIRECTORY: '/foreign/objects',
          GIT_ALTERNATE_OBJECT_DIRECTORIES: '/foreign/alternates' },
          stdout: 'pipe', stderr: 'pipe' },
      )
      const json = cli('--json')
      expect(json.exitCode).toBe(0)
      expect(JSON.parse(json.stdout.toString())[0]).toMatchObject({ id: open.reviewId, coverage: 'exact' })
      const human = cli('--open')
      expect(human.exitCode).toBe(0)
      expect(human.stdout.toString()).toContain(`${open.reviewId}`)
      expect(human.stdout.toString()).toContain('exact')
      const show = Bun.spawnSync([
        process.execPath, new URL('cli.ts', import.meta.url).pathname, 'review', 'show', String(open.reviewId), '--json',
      ], { env: { ...process.env, ORCH_DEPTH: '0', GIT_OBJECT_DIRECTORY: '/foreign/objects',
        GIT_ALTERNATE_OBJECT_DIRECTORIES: '/foreign/alternates' },
        stdout: 'pipe', stderr: 'pipe' })
      expect(show.exitCode).toBe(0)
      expect(JSON.parse(show.stdout.toString()).lenses[0].pin.resolves).toBe(true)
      const badSince = cli('--since', '2026-01-01')
      expect(badSince.exitCode).toBe(1)
      expect(badSince.stderr.toString()).toContain('ISO datetime')
      const splitRuns = ['reviewed', 'missing-branch'].map((branch, index) => {
        const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'model-a',
          lens: `split-${index}`, repo: project, inputTree: gg('rev-parse', 'reviewed^{tree}'),
          headCommit: gg('rev-parse', 'reviewed') })
        db().query('UPDATE run SET branch=?, base_commit=? WHERE id=?').run(branch, gg('rev-parse', 'main'), runId)
        return runId
      })
      const splitReview = recordReviews(splitRuns.map((runId) => ({ runId, output: reviewReply(0) })))
      completeReview(splitReview)
      expect(listReviews({ project }).find((row) => row.id === splitReview)?.coverage).toBeNull()
      writeFileSync(join(repo, 'change.txt'), 'two\n'); gg('add', '.'); gg('commit', '-m', 'move branch')
      rows = listReviews({ project })
      expect(rows.filter((row) => row.id !== splitReview).every((row) => row.coverage === 'stale')).toBe(true)
      expect(rows.find((row) => row.id === splitReview)?.coverage).toBeNull()

      const shown = getReview(open.reviewId)
      expect(shown.findings).toEqual([expect.objectContaining({ evidence: 'evidence 1', disposition: null })])
      expect(shown.lenses[0]).toMatchObject({ run_id: open.runId, lens: 'read-open', reviewed_tree: expect.any(String),
        review_ref: `refs/orch/reviewed/${open.runId}`, grading: { reproduced: 'all', coverage: 'adequate', limits: 'named', overlap: 'alone' },
        pin: { resolves: true, commit: expect.any(String) } })
    } finally { rmSync(repo, { recursive: true, force: true }) }
  }, 20_000)

  test('fleet calibration groups graded models and emits null-model empty record pairs', () => {
    const graded = addRun({ agent: 'codex', job: 'review-lens', model: 'm1', lens: 'fleet-a' })
    const gradedReview = recordReview(graded, reviewReply(MIN_REVIEW_TRIAGED))
    gradeReviewLens(graded, null, { reproduced: 'all', coverage: 'adequate', limits: 'named', overlap: 'alone' })
    for (let i = 1; i <= MIN_REVIEW_TRIAGED; i++) triageFinding(gradedReview, i, 'accepted')
    completeReview(gradedReview)
    db().query("INSERT INTO score (run_id,delivery,quality,scored_at) VALUES (?,'full','right',?)")
      .run(graded, '2026-02-03T00:00:00.000Z')
    const ungraded = addRun({ agent: 'grok', job: 'review-lens', model: 'm2', lens: 'fleet-b' })
    const ungradedReview = recordReview(ungraded, reviewReply(0)); completeReview(ungradedReview)
    for (const model of ['m3', 'm4']) {
      const runId = addRun({ agent: 'codex', job: 'review-lens', model, lens: 'fleet-c' })
      const reviewId = recordReview(runId, reviewReply(MIN_REVIEW_TRIAGED / 2))
      gradeReviewLens(runId, null, { reproduced: 'all', coverage: 'adequate', limits: 'named', overlap: 'alone' })
      for (let i = 1; i <= MIN_REVIEW_TRIAGED / 2; i++) triageFinding(reviewId, i, 'accepted')
      completeReview(reviewId)
      db().query("INSERT INTO score (run_id,delivery,quality,scored_at) VALUES (?,'full','right',?)")
        .run(runId, model === 'm3' ? '2026-02-04T00:00:00.000Z' : '2026-02-05T00:00:00.000Z')
    }
    const legacy = addRun({ agent: 'legacy', job: 'review-lens', model: 'legacy-model', lens: 'fleet-d' })
    const legacyReview = recordReview(legacy, reviewReply(MIN_REVIEW_TRIAGED))
    db().query('UPDATE review_lens SET model=NULL WHERE run_id=?').run(legacy)
    gradeReviewLens(legacy, null, { reproduced: 'all', coverage: 'adequate', limits: 'named', overlap: 'alone' })
    for (let i = 1; i <= MIN_REVIEW_TRIAGED; i++) triageFinding(legacyReview, i, 'accepted')
    completeReview(legacyReview)
    db().query("INSERT INTO score (run_id,delivery,quality,scored_at) VALUES (?,'full','right',?)")
      .run(legacy, '2026-02-06T00:00:00.000Z')

    expect(reviewCalibrationFleet()).toEqual([
      { lens: 'fleet-a', agent: 'codex', model: 'm1', n: MIN_REVIEW_TRIAGED, precision: 1, basis: 'model', last_graded_at: '2026-02-03T00:00:00.000Z' },
      { lens: 'fleet-a', agent: 'grok', model: null, n: 0, precision: null, basis: null, last_graded_at: null },
      { lens: 'fleet-a', agent: 'legacy', model: null, n: 0, precision: null, basis: null, last_graded_at: null },
      { lens: 'fleet-b', agent: 'codex', model: null, n: 0, precision: null, basis: null, last_graded_at: null },
      { lens: 'fleet-b', agent: 'grok', model: null, n: 0, precision: null, basis: null, last_graded_at: null },
      { lens: 'fleet-b', agent: 'legacy', model: null, n: 0, precision: null, basis: null, last_graded_at: null },
      { lens: 'fleet-c', agent: 'codex', model: 'm3', n: MIN_REVIEW_TRIAGED / 2, precision: null, basis: 'model', last_graded_at: '2026-02-04T00:00:00.000Z' },
      { lens: 'fleet-c', agent: 'codex', model: 'm4', n: MIN_REVIEW_TRIAGED / 2, precision: null, basis: 'model', last_graded_at: '2026-02-05T00:00:00.000Z' },
      { lens: 'fleet-c', agent: 'codex', model: null, n: MIN_REVIEW_TRIAGED, precision: 1, basis: 'aggregate', last_graded_at: '2026-02-05T00:00:00.000Z' },
      { lens: 'fleet-c', agent: 'grok', model: null, n: 0, precision: null, basis: null, last_graded_at: null },
      { lens: 'fleet-c', agent: 'legacy', model: null, n: 0, precision: null, basis: null, last_graded_at: null },
      { lens: 'fleet-d', agent: 'codex', model: null, n: 0, precision: null, basis: null, last_graded_at: null },
      { lens: 'fleet-d', agent: 'grok', model: null, n: 0, precision: null, basis: null, last_graded_at: null },
      { lens: 'fleet-d', agent: 'legacy', model: null, n: MIN_REVIEW_TRIAGED, precision: 1, basis: 'aggregate', last_graded_at: '2026-02-06T00:00:00.000Z' },
    ])
  })

  test('recording refuses lens runs from different projects', () => {
    const first = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'one', repo: 'project-one' })
    const second = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'two', repo: 'project-two' })
    expect(() => recordReviews([
      { runId: first, output: reviewReply(0) }, { runId: second, output: reviewReply(0) },
    ])).toThrow('project-one, project-two')
    expect(db().query('SELECT COUNT(*) AS n FROM review').get()).toEqual({ n: 0 })
  })

  test('review help exits zero and names every review verb', () => {
    const p = Bun.spawnSync([process.execPath, new URL('cli.ts', import.meta.url).pathname, 'review', '--help'], {
      env: { ...process.env, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(p.exitCode).toBe(0)
    const output = p.stdout.toString()
    for (const verb of ['list', 'show', 'tier', 'record', 'triage', 'complete', 'pins', 'calibration']) {
      expect(output).toContain(`orch review ${verb}`)
    }
  })

  test('records a tier from one shared base and reviewed tree and exposes CLI JSON', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-tier-')))
    const gg = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], { cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    gg('init', '-b', 'main'); gg('config', 'user.email', 'orch-test@example.invalid'); gg('config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'base.txt'), 'base\n'); gg('add', 'base.txt'); gg('commit', '-m', 'base')
    gg('checkout', '-b', 'tier-review'); writeFileSync(join(repo, 'change.ts'), 'change\n'); gg('add', 'change.ts'); gg('commit', '-m', 'change')
    upsertProject({ name: 'tier-review-project', path: repo, settings: { trunk: 'main' } })
    try {
      const base = gg('rev-parse', 'main')
      const head = gg('rev-parse', 'tier-review')
      writeFileSync(join(repo, 'base.txt'), 'carried tracked change\n'.repeat(60))
      mkdirSync(join(repo, 'shared'))
      writeFileSync(join(repo, 'shared', 'carried.ts'), 'carried untracked change\n')
      const tree = contentTree(repo)
      const runs = ['correctness', 'craft'].map((lens) => addRun({
        agent: 'codex', job: 'review-lens', model: 'm', lens,
        repo: 'tier-review-project', inputTree: tree, headCommit: head,
      }))
      for (const id of runs) db().query('UPDATE run SET base_commit=?, branch=? WHERE id=?')
        .run(base, 'tier-review', id)
      const oldObjectDirectory = process.env.GIT_OBJECT_DIRECTORY
      const oldAlternates = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES
      process.env.GIT_OBJECT_DIRECTORY = '/foreign/object-directory'
      process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = '/foreign/alternates'
      let reviewId: number
      try {
        reviewId = recordReviews(runs.map((runId) => ({ runId, output: reviewReply(0) })))
      } finally {
        if (oldObjectDirectory === undefined) delete process.env.GIT_OBJECT_DIRECTORY
        else process.env.GIT_OBJECT_DIRECTORY = oldObjectDirectory
        if (oldAlternates === undefined) delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES
        else process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = oldAlternates
      }
      const row = db().query(
        'SELECT tier, tier_risk, tier_size, tier_reasons, tier_reason FROM review WHERE id=?',
      ).get(reviewId) as { tier: number; tier_risk: number; tier_size: number; tier_reasons: string; tier_reason: string }
      expect(row).toMatchObject({ tier: 3, tier_risk: 3, tier_size: 2 })
      expect(JSON.parse(row.tier_reasons).join('\n')).toContain('shared/carried.ts')
      expect(row.tier_reason).toContain('risk 3: shared/carried.ts')

      const tierCli = (target: string) => Bun.spawnSync([
        process.execPath, new URL('cli.ts', import.meta.url).pathname,
        'review', 'tier', target, '--json',
      ], { cwd: repo, env: { ...hermeticGitEnv(), ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe' })
      const carried = tierCli(String(runs[0]))
      expect(carried.stderr.toString()).toBe('')
      expect(carried.exitCode).toBe(0)
      expect(JSON.parse(carried.stdout.toString())).toMatchObject({ tier: 3, risk: 3, size: 2 })

      writeFileSync(join(repo, 'base.txt'), 'base\n'); rmSync(join(repo, 'shared'), { recursive: true })
      gg('checkout', 'main'); gg('merge', '--ff-only', 'tier-review')
      const merged = tierCli('tier-review')
      expect(JSON.parse(merged.stdout.toString())).toMatchObject({ tier: 0, risk: 0, size: 0 })
      expect(JSON.parse(merged.stdout.toString()).reasons).toContain('risk 0: no branch-side change')

      const docsBase = gg('rev-parse', 'main')
      gg('checkout', '-b', 'docs-only'); writeFileSync(join(repo, 'README.md'), '# docs\n')
      gg('add', 'README.md'); gg('commit', '-m', 'docs')
      const docs = tierCli(`${docsBase}..${gg('rev-parse', 'HEAD')}`)
      expect(JSON.parse(docs.stdout.toString())).toMatchObject({ tier: 0, risk: 0, size: 0 })
      const bareCommit = tierCli(gg('rev-parse', 'HEAD'))
      expect(bareCommit.exitCode).toBe(1)
      expect(bareCommit.stderr.toString()).toContain(
        'review tier accepts a branch, run id, or explicit <from>..<to> range',
      )
    } finally { rmSync(repo, { recursive: true, force: true }) }
  }, 20_000)

  test('stores null tier and names differing lens bases', () => {
    const tree = '1'.repeat(40)
    const first = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'one', inputTree: tree })
    const second = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'two', inputTree: tree })
    db().query('UPDATE run SET base_commit=? WHERE id=?').run('a'.repeat(40), first)
    db().query('UPDATE run SET base_commit=? WHERE id=?').run('b'.repeat(40), second)
    const stderr = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const reviewId = recordReviews([
        { runId: first, output: reviewReply(0) }, { runId: second, output: reviewReply(0) },
      ])
      expect(db().query('SELECT tier, tier_risk, tier_size, tier_reasons, tier_reason FROM review WHERE id=?')
        .get(reviewId)).toEqual({ tier: null, tier_risk: null, tier_size: null, tier_reasons: null, tier_reason: null })
      expect(stderr.mock.calls.flat().join(' ')).toContain(`run ${first}=${'a'.repeat(40)}`)
      expect(stderr.mock.calls.flat().join(' ')).toContain(`run ${second}=${'b'.repeat(40)}`)
    } finally { stderr.mockRestore() }
  })

  test('coverage audit compares each lens to trunk at cut time, not later trunk history', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-coverage-audit-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      git('init', '-b', 'main')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'trunk.txt'), 'trunk\n')
      git('add', 'trunk.txt')
      git('commit', '-m', 'trunk fixture')
      const trunkCommit = git('rev-parse', 'main^{commit}')
      const trunkTree = git('rev-parse', 'main^{tree}')
      git('checkout', '-b', 'feature/audit')
      writeFileSync(join(repo, 'branch-only.txt'), 'branch\n')
      git('add', 'branch-only.txt')
      git('commit', '-m', 'branch fixture')
      const branchTree = git('rev-parse', 'HEAD^{tree}')
      git('checkout', 'main')
      git('merge', '--ff-only', 'feature/audit')
      upsertProject({ name: 'coverage-audit-fixture', path: repo, settings: { trunk: 'main' } })

      const trunkRun = addRun({
        agent: 'codex', job: 'review-lens', model: 'm', lens: 'trunk',
        repo: 'coverage-audit-fixture', inputTree: trunkTree,
      })
      const branchRun = addRun({
        agent: 'codex', job: 'review-lens', model: 'm', lens: 'branch',
        repo: 'coverage-audit-fixture', inputTree: branchTree,
      })
      const mixedTrunkRun = addRun({
        agent: 'codex', job: 'review-lens', model: 'm', lens: 'mixed-trunk',
        repo: 'coverage-audit-fixture', inputTree: trunkTree,
      })
      const mixedBranchRun = addRun({
        agent: 'codex', job: 'review-lens', model: 'm', lens: 'mixed-branch',
        repo: 'coverage-audit-fixture', inputTree: trunkTree,
      })
      for (const runId of [trunkRun, branchRun, mixedTrunkRun, mixedBranchRun]) {
        db().query('UPDATE run SET base_commit=? WHERE id=?').run(trunkCommit, runId)
      }
      const trunkReview = recordReview(trunkRun, reviewReply(0))
      const branchReview = recordReview(branchRun, reviewReply(0))
      const partialReview = recordReviews([
        { runId: mixedTrunkRun, output: reviewReply(0) },
        { runId: mixedBranchRun, output: reviewReply(0) },
      ])
      // Historical rows can predate the mixed-tree recording guard. Preserve
      // one such row shape to exercise the audit's partial-review report.
      db().query('UPDATE review_lens SET reviewed_tree=? WHERE run_id=?')
        .run(branchTree, mixedBranchRun)
      completeReview(trunkReview)
      completeReview(branchReview)
      completeReview(partialReview)
      expect(coverageAudit()).toEqual({
        count: 1,
        review_ids: [trunkReview],
        partial_review_ids: [partialReview],
      })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('findings jobs have stable identities and the structured coverage contract', () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      for (const name of ['review-lens', 'review-lens-inline', 'safety', 'craft']) {
        expect(JOBS[name]!.findings).toBe(true)
        expect(() => preflight(name, process.cwd())).toThrow('requires a stable lens identity')
      }
      expect(JOBS['verify-claim']!.findings).not.toBe(true)
      expect(() => preflight('verify-claim', process.cwd(), undefined, undefined, undefined,
        false, false, 'claim')).toThrow('--lens is only valid')
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
    expect(REVIEW_SCHEMA.properties.provenance.required).toEqual([
      'standards_read', 'model_used', 'files_covered',
      'commands_run', 'could_not_verify', 'canon_source',
    ])
    expect(REVIEW_SCHEMA.properties.provenance.properties.canon_source)
      .toBe(VERIFY_CLAIM_SCHEMA.properties.provenance.properties.canon_source)
    expect(VERIFY_CLAIM_SCHEMA.properties.verdict.enum).toEqual(['true', 'false', 'undecidable'])
  })

  test('review parsing requires one of the three canon provenance values', () => {
    expect(parseReviewReply(reviewReply(0))?.provenance.canon_source).toBe('live database')
    const missing = reviewReply(0) as Record<string, any>
    delete missing.provenance.canon_source
    expect(parseReviewReply(missing)).toBeNull()
    expect(parseReviewReply({
      ...reviewReply(0), provenance: { ...reviewReply(0).provenance, canon_source: 'connected' },
    })).toBeNull()
  })

  test('review parsing accepts an omitted or legacy claimed tree', () => {
    const omitted = reviewReply(0)
    delete (omitted.provenance as Partial<typeof omitted.provenance>).tree_inspected
    expect(parseReviewReply(omitted)?.provenance.tree_inspected).toBeUndefined()
    expect(parseReviewReply(reviewReply(0))?.provenance.tree_inspected).toBe('abc123')
  })

  test('records each lens before triage and derives runner and model from the orch run', () => {
    const first = addRun({ agent: 'codex', job: 'review-lens', model: 'effective-a', lens: 'safety' })
    const second = addRun({ agent: 'grok', job: 'craft', model: 'effective-b', lens: 'craft' })
    const review = recordReviews([
      { runId: first, output: reviewReply() }, { runId: second, output: reviewReply(0) },
    ])
    const rows = db().query(
      `SELECT rl.run_id, rl.lens, rl.agent, rl.model, r.completed_at
         FROM review_lens rl JOIN review r ON r.id=rl.review_id ORDER BY rl.run_id`,
    ).all() as { run_id: number; lens: string; agent: string; model: string; completed_at: string | null }[]
    expect(rows).toEqual([
      { run_id: first, lens: 'safety', agent: 'codex', model: 'effective-a', completed_at: null },
      { run_id: second, lens: 'craft', agent: 'grok', model: 'effective-b', completed_at: null },
    ])
    expect(() => completeReview(review)).toThrow('untriaged')
    triageFinding(review, 1, 'accepted')
    completeReview(review)
    expect(db().query('SELECT completed_at FROM review WHERE id=?').get(review) as
      { completed_at: string }).toHaveProperty('completed_at')
  })

  test('records orch-measured trees, refuses mixed measured content, and keeps claims optional', () => {
    const tree = '1111111111111111111111111111111111111111'
    const first = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'one', inputTree: tree })
    const second = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'two', inputTree: tree })
    const withoutClaim = reviewReply(0)
    delete (withoutClaim.provenance as Partial<typeof withoutClaim.provenance>).tree_inspected
    const review = recordReviews([
      { runId: first, output: withoutClaim }, { runId: second, output: reviewReply(0) },
    ])
    expect(db().query(
      'SELECT tree_inspected, reviewed_tree FROM review_lens WHERE review_id=? ORDER BY id',
    ).all(review)).toEqual([
      { tree_inspected: null, reviewed_tree: tree },
      { tree_inspected: 'abc123', reviewed_tree: tree },
    ])

    const third = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'three',
      inputTree: '2222222222222222222222222222222222222222' })
    expect(() => recordReviews([
      { runId: third, output: reviewReply(0) },
      { runId: addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'four',
        inputTree: '3333333333333333333333333333333333333333' }), output: reviewReply(0) },
    ])).toThrow(`run ${third}: 2222222222222222222222222222222222222222`)
  })

  test('an unregistered project warns after recording and does not block later grading', () => {
    const runId = addRun({
      agent: 'codex', job: 'review-lens', model: 'm', lens: 'unregistered-pin',
      repo: 'not-registered', headCommit: 'a'.repeat(40),
    })
    const stderr = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const reviewId = recordReview(runId, reviewReply(0))
      expect(reviewId).toBeGreaterThan(0)
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining(
        `refs/orch/reviewed/${runId} was not created: project not-registered is not registered`,
      ))
      expect(() => gradeReviewLens(runId, null, {
        reproduced: 'none', coverage: 'adequate', limits: 'named', overlap: 'none',
      })).not.toThrow()
      expect(db().query('SELECT COUNT(*) AS n FROM review WHERE id=?').get(reviewId))
        .toEqual({ n: 1 })
    } finally { stderr.mockRestore() }
  })

  test('an update-ref refusal warns after recording and does not block later grading', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-review-pin-refusal-'))
    const runGit = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString().trim())
      return p.stdout.toString().trim()
    }
    runGit('init', '-b', 'main')
    runGit('config', 'user.email', 'orch-test@example.invalid')
    runGit('config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    runGit('add', 'base.txt')
    runGit('commit', '-m', 'base')
    const project = 'review-pin-refusal'
    upsertProject({ name: project, path: repo, settings: { trunk: 'main' } })
    const runId = addRun({
      agent: 'codex', job: 'review-lens', model: 'm', lens: 'refused-pin', repo: project,
      inputTree: runGit('rev-parse', 'HEAD^{tree}'), headCommit: runGit('rev-parse', 'HEAD'),
    })
    const refDir = join(repo, '.git', 'refs', 'orch', 'reviewed')
    mkdirSync(refDir, { recursive: true })
    writeFileSync(join(refDir, `${runId}.lock`), 'held\n')
    const stderr = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const reviewId = recordReview(runId, reviewReply(0))
      expect(reviewId).toBeGreaterThan(0)
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining(
        `refs/orch/reviewed/${runId} was not created: git update-ref failed:`,
      ))
      expect(() => runGit('rev-parse', `refs/orch/reviewed/${runId}`)).toThrow()
      expect(() => gradeReviewLens(runId, null, {
        reproduced: 'none', coverage: 'adequate', limits: 'absent', overlap: 'none',
      })).not.toThrow()
      expect(db().query('SELECT COUNT(*) AS n FROM review WHERE id=?').get(reviewId))
        .toEqual({ n: 1 })
    } finally {
      stderr.mockRestore()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('the grading capture path creates the same reviewed-commit pin', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-review-grade-pin-'))
    const runGit = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString().trim())
      return p.stdout.toString().trim()
    }
    try {
      runGit('init', '-b', 'main')
      runGit('config', 'user.email', 'orch-test@example.invalid')
      runGit('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      runGit('add', 'base.txt')
      runGit('commit', '-m', 'base')
      const project = 'review-grade-pin'
      upsertProject({ name: project, path: repo, settings: { trunk: 'main' } })
      const commit = runGit('rev-parse', 'HEAD')
      const runId = addRun({
        agent: 'codex', job: 'review-lens', model: 'm', lens: 'grade-pin', repo: project,
        inputTree: runGit('rev-parse', 'HEAD^{tree}'), headCommit: commit,
      })
      gradeReviewLens(runId, reviewReply(0), {
        reproduced: 'none', coverage: 'adequate', limits: 'named', overlap: 'none',
      })
      expect(runGit('rev-parse', `refs/orch/reviewed/${runId}`)).toBe(commit)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('precision counts accepted and modified as hits, rejects as misses, and skips nothing', () => {
    const make = (model: string, disposition: 'accepted' | 'modified' | 'rejected' | 'skipped', n: number) => {
      const runId = addRun({ agent: 'codex', job: 'review-lens', model, lens: 'correctness' })
      const reviewId = recordReview(runId, reviewReply(n))
      for (let i = 1; i <= n; i++) triageFinding(reviewId, i, disposition,
        disposition === 'rejected' ? 'not-a-defect' : undefined)
      completeReview(reviewId)
    }
    make('old', 'accepted', 4)
    make('old', 'modified', 3)
    make('old', 'rejected', 3)
    make('old', 'skipped', 8)
    let c = reviewCalibration('correctness', 'codex', 'current')
    expect(c).toMatchObject({ precision: 0.7, hits: 7, triaged: 10, basis: 'agent' })
    expect(c.rejection_categories).toEqual([{ category: 'not-a-defect', count: 3 }])
    expect(c.tiers.unclassified).toEqual({
      reviews: 4, lenses: 4, findings_accepted: 4, findings_rejected: 3,
      rounds: { min: 1, median: 1, max: 1 },
    })

    make('current', 'accepted', MIN_REVIEW_TRIAGED - 1)
    c = reviewCalibration('correctness', 'codex', 'current')
    expect(c.basis).toBe('agent')
    make('current', 'rejected', 1)
    c = reviewCalibration('correctness', 'codex', 'current')
    expect(c).toMatchObject({ precision: 0.9, hits: 9, triaged: 10, basis: 'model' })
  })

  test('below-floor and untriaged evidence report null, never zero', () => {
    const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'efficiency' })
    const reviewId = recordReview(runId, reviewReply(1))
    triageFinding(reviewId, 1, 'rejected', 'false-positive')
    expect(reviewCalibration('efficiency', 'codex', 'm').precision).toBeNull()
    completeReview(reviewId)
    const c = reviewCalibration('efficiency', 'codex', 'm')
    expect(c.precision).toBeNull()
    expect(calibrationLine(c)).toContain('no reliable precision yet')
  })

  test('derives MIRROR review recording and calibration from the lens run without changing review_lens schema', () => {
    const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'mirror-mode' })
    db().query(
      `UPDATE run SET mcp=1, mcp_server='fixture-project', mcp_connected=0,
                      mcp_error='mirror: attachment failed' WHERE id=?`,
    ).run(runId)
    const reviewId = recordReview(runId, reviewReply(0))
    completeReview(reviewId)
    const calibration = reviewCalibration('mirror-mode', 'codex', 'm')
    expect(calibration.mirror_lenses).toBe(1)
    expect(calibrationLine(calibration)).toContain('MIRROR lenses: 1')

    const ddl = (db().query(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='review_lens'",
    ).get() as { sql: string }).sql
    expect(ddl).not.toContain('mcp_mode')
    expect(ddl).not.toContain('provenance')

    const cliRun = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'mirror-mode' })
    const output = join(dir, 'mirror-review-output.json')
    writeFileSync(output, JSON.stringify(reviewReply(0)))
    db().query(
      `UPDATE run SET output_path=?, mcp=1, mcp_server='fixture-project', mcp_connected=0,
                      mcp_error='mirror: attachment failed' WHERE id=?`,
    ).run(output, cliRun)
    const recorded = Bun.spawnSync([
      process.execPath, new URL('cli.ts', import.meta.url).pathname,
      'review', 'record', String(cliRun),
    ], { env: { ...process.env, ORCH_DB: process.env.ORCH_DB! }, stdout: 'pipe', stderr: 'pipe' })
    expect(recorded.exitCode).toBe(0)
    expect(recorded.stdout.toString()).toContain(`MIRROR lens run ${cliRun}`)
  })

  test('per-tier calibration counts lens rounds per branch', () => {
    for (const [branch, rounds] of [['one-round', 1], ['three-rounds', 3]] as const) {
      for (let round = 0; round < rounds; round++) {
        const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'rounds' })
        db().query('UPDATE run SET branch=?, launch_key=? WHERE id=?')
          .run(`${branch}-worker-${round}`, branch, runId)
        const reviewId = recordReview(runId, reviewReply(0))
        db().query("UPDATE review SET tier=2, tier_risk=2, tier_size=0, tier_reason='risk 2: fixture' WHERE id=?")
          .run(reviewId)
        completeReview(reviewId)
      }
    }
    const tiers = reviewCalibration('rounds', 'codex', 'm').tiers
    expect(tiers['2'].rounds).toEqual({ min: 1, median: 2, max: 3 })
    expect(tiers['0'].rounds).toEqual({ min: null, median: null, max: null })
  })

  test('triage records explicit severity agreement and leaves omission unassessed', () => {
    const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'severity' })
    const reviewId = recordReview(runId, reviewReply(2))
    db().query("UPDATE review_finding SET severity='high' WHERE review_id=? AND ordinal=2")
      .run(reviewId)
    triageFinding(reviewId, 1, 'accepted', undefined, 'critical')
    triageFinding(reviewId, 2, 'modified', undefined, 'high')
    expect(db().query(
      'SELECT ordinal, severity, triaged_severity FROM review_finding WHERE review_id=? ORDER BY ordinal',
    ).all(reviewId)).toEqual([
      { ordinal: 1, severity: 'major', triaged_severity: 'critical' },
      { ordinal: 2, severity: 'high', triaged_severity: 'high' },
    ])
    expect(() => triageFinding(reviewId, 1, 'accepted', undefined, 'banana'))
      .toThrow('critical | high | medium | low')
    expect(() => db().query("UPDATE review_finding SET triaged_severity='banana' WHERE review_id=?")
      .run(reviewId)).toThrow()
  })

  test('calibration and state count graded values and preserve historical null grades', () => {
    const gradedRun = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'graded' })
    const gradedReview = recordReview(gradedRun, reviewReply(MIN_REVIEW_TRIAGED))
    gradeReviewLens(gradedRun, null, {
      reproduced: 'all', coverage: 'adequate', limits: 'named', overlap: 'alone',
    })
    for (let i = 1; i <= MIN_REVIEW_TRIAGED; i++) triageFinding(gradedReview, i, 'accepted')
    completeReview(gradedReview)

    const historicalRun = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'graded' })
    const historicalReview = recordReview(historicalRun, reviewReply(1))
    triageFinding(historicalReview, 1, 'accepted')
    completeReview(historicalReview)

    const c = reviewCalibration('graded', 'codex', 'm')
    expect(c.reproduced).toEqual({
      counts: { none: 0, some: 0, all: 1 },
      shares: { none: 0, some: 0, all: 1 },
      ungraded: 1,
    })
    expect(c.overlap).toEqual({
      counts: { unique: 0, shared: 0, none: 0, alone: 1 },
      shares: { unique: 0, shared: 0, none: 0, alone: 1 },
      ungraded: 1,
    })
    expect(c.severity).toEqual({
      counts: { agreed: 0, changed: 0, not_comparable: 0, not_assessed: MIN_REVIEW_TRIAGED + 1 },
      shares: { agreed: 0, changed: 0, not_comparable: 0, not_assessed: 1 },
    })
    const cells = state(null).reviewCalibration as typeof c[]
    expect(cells.find((cell) => cell.lens === 'graded' && cell.model === 'm'))
      .toMatchObject({ reproduced: c.reproduced, overlap: c.overlap })
  })

  test('grade shares use graded rows independently of the finding precision floor', () => {
    const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'clean-grade' })
    const reviewId = recordReview(runId, reviewReply(0))
    gradeReviewLens(runId, null, {
      reproduced: 'none', coverage: 'adequate', limits: 'absent', overlap: 'none',
    })
    completeReview(reviewId)
    const c = reviewCalibration('clean-grade', 'codex', 'm')
    expect(c.precision).toBeNull()
    expect(c.coverage).toEqual({
      counts: { empty: 0, partial: 0, adequate: 1 },
      shares: { empty: 0, partial: 0, adequate: 1 },
      ungraded: 0,
    })
  })

  test('severity calibration separates agreement, changes, and off-scale lens claims', () => {
    const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'severity-cell' })
    const reviewId = recordReview(runId, reviewReply(3, 'high'))
    db().query("UPDATE review_finding SET severity='major' WHERE review_id=? AND ordinal=3").run(reviewId)
    triageFinding(reviewId, 1, 'accepted', undefined, 'high')
    triageFinding(reviewId, 2, 'accepted', undefined, 'critical')
    triageFinding(reviewId, 3, 'accepted', undefined, 'low')
    completeReview(reviewId)
    expect(reviewCalibration('severity-cell', 'codex', 'm').severity).toEqual({
      counts: { agreed: 1, changed: 1, not_comparable: 1, not_assessed: 0 },
      shares: { agreed: 1 / 3, changed: 1 / 3, not_comparable: 1 / 3, not_assessed: 0 },
    })
  })

  test('uses only the most recent fifty complete reviews', () => {
    const add = (disposition: 'accepted' | 'rejected') => {
      const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'window' })
      const reviewId = recordReview(runId, reviewReply(1))
      triageFinding(reviewId, 1, disposition,
        disposition === 'rejected' ? 'false-positive' : undefined)
      completeReview(reviewId)
    }
    add('accepted')
    for (let i = 0; i < 50; i++) add('rejected')
    expect(reviewCalibration('window', 'codex', 'm')).toMatchObject({
      precision: 0, hits: 0, triaged: 50, basis: 'model',
    })
  })

  test('appends the selected agent calibration before hashing and storing its final prompt', async () => {
    const agent = AGENTS.codex!
    const original = { bin: agent.bin, argv: agent.argv, stdin: agent.stdin, readsOut: agent.readsOut }
    let sent = ''
    let sentSchema: string | undefined
    const output = JSON.stringify(reviewReply(0))
    try {
      // Qualifying evidence exists for the selected agent and nowhere else.
      const evidenceRun = addRun({ agent: 'codex', job: 'review-lens-inline',
        model: agent.model, lens: 'bound-prompt' })
      const evidenceReview = recordReview(evidenceRun, reviewReply(MIN_REVIEW_TRIAGED))
      for (let i = 1; i <= MIN_REVIEW_TRIAGED; i++) triageFinding(evidenceReview, i, 'accepted')
      completeReview(evidenceReview)

      agent.bin = process.execPath
      agent.stdin = false
      agent.readsOut = false
      agent.argv = ({ prompt, schema }) => {
        sent = prompt
        sentSchema = schema
        return ['-e', `console.log(${JSON.stringify(output)})`]
      }
      process.env.ORCH_DEPTH = '0'
      const result = await runJob({ job: 'review-lens-inline', prompt: 'inspect this pack',
        agent: 'codex', lens: 'bound-prompt' })
      expect(sent).toContain('closed scale: critical | high | medium | low')
      expect(sent).toContain('precision 1.00 over 10 triaged findings')
      expect(JSON.parse(readFileSync(sentSchema!, 'utf8'))).toEqual(strictCodexSchema(REVIEW_SCHEMA))
      const row = db().query('SELECT prompt_sha, prompt_path, lens FROM run WHERE id=?').get(result.id) as
        { prompt_sha: string; prompt_path: string; lens: string }
      const bound = readFileSync(row.prompt_path.replace(/\.prompt\.txt$/, '.bound.txt'), 'utf8')
      expect(bound).toBe(sent)
      expect(row.prompt_sha).toBe(createHash('sha256').update(sent).digest('hex').slice(0, 16))
      expect(row.lens).toBe('bound-prompt')
      expect(readFileSync(row.prompt_path, 'utf8')).toBe('inspect this pack')
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.stdin = original.stdin
      agent.readsOut = original.readsOut
    }
  })
})
