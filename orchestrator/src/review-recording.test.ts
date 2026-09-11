import { describe,expect,spyOn,test } from 'bun:test'
import { mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRun,completeReview,contentTree,coverageAudit,db,getReview,gradeReviewLens,hermeticGitEnv,listReviews,recordReview,recordReviews,reviewReply,triageFinding,upsertProject } from '../test/fixture.ts'
import { changeIdentity } from './change-identity.ts'

describe('review discipline', () => {
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
        return { runId, reviewId: recordReview(runId, reviewReply(findings), db()) }
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
test('recording refuses lens runs from different projects', () => {
    const first = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'one', repo: 'project-one' })
    const second = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'two', repo: 'project-two' })
    expect(() => recordReviews([
      { runId: first, output: reviewReply(0) }, { runId: second, output: reviewReply(0) },
    ])).toThrow('project-one, project-two')
    expect(db().query('SELECT COUNT(*) AS n FROM review').get()).toEqual({ n: 0 })
  })
test('a carried review stores the persist-time change identity when base through HEAD is empty', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-carried-review-identity-')))
    const git = (args: string[], stdin?: Uint8Array) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdin, stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return { stdout: new Uint8Array(p.stdout), stderr: p.stderr.toString(), exitCode: p.exitCode }
    }
    const gg = (...args: string[]) => new TextDecoder().decode(git(args).stdout).trim()
    try {
      gg('init', '-b', 'main')
      gg('config', 'user.email', 'orch-test@example.invalid')
      gg('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'reviewed.txt'), 'base\n')
      gg('add', 'reviewed.txt')
      gg('commit', '-m', 'DEV-377 fixture base')
      const base = gg('rev-parse', 'HEAD')
      writeFileSync(join(repo, 'reviewed.txt'), 'carried change\n')
      const inputTree = contentTree(repo)
      upsertProject({ name: 'carried-review-identity', path: repo, settings: { trunk: 'main' } })
      const runId = addRun({
        agent: 'codex', job: 'review-lens', model: 'm', lens: 'correctness',
        repo: 'carried-review-identity', inputTree, headCommit: base,
      })
      db().query(
        'UPDATE run SET base_commit=?, review_ref=?, changed_paths=? WHERE id=?',
      ).run(base, 'feature/carried', JSON.stringify(['reviewed.txt']), runId)

      const reviewId = recordReviews([{ runId, output: reviewReply(0) }])
      const expectedPatchId = changeIdentity((args, stdin) => {
        const result = git(args, stdin)
        return {
          ok: result.exitCode === 0, stdout: result.stdout,
          out: new TextDecoder().decode(result.stdout).trim(), err: result.stderr,
        }
      }, base, inputTree)
      expect(db().query('SELECT patch_id, path_set FROM review WHERE id=?').get(reviewId)).toEqual({
        patch_id: expectedPatchId,
        path_set: JSON.stringify(['reviewed.txt']),
      })
    } finally {
      rmSync(repo, { recursive: true, force: true })
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
      const trunkReview = recordReview(trunkRun, reviewReply(0), db())
      const branchReview = recordReview(branchRun, reviewReply(0), db())
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
})
