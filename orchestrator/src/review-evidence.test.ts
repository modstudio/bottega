import { describe,expect,test } from 'bun:test'
import { mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRun,cleanReviewEvidence,db,hermeticGitEnv,recordReview,removeProject,reviewReply,upsertProject } from '../test/fixture.ts'

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
        failure: 'clean review with no evidence: files_covered and commands_run are empty',
        note: null, kind: 'unevidenced',
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
      expect(cleanReviewEvidence(runId, reply)).toMatchObject({
        failure: expect.stringContaining('intersects none'), kind: 'unevidenced',
      })

      const segmentBase = gg('rev-parse', 'HEAD')
      mkdirSync(join(repo, 'foo'), { recursive: true })
      writeFileSync(join(repo, 'foo', 'bar-x.ts'), 'segment boundary\n')
      gg('add', '.'); gg('commit', '-m', 'segment boundary')
      db().query('UPDATE run SET base_commit=?, input_tree=? WHERE id=?')
        .run(segmentBase, gg('rev-parse', 'HEAD^{tree}'), runId)
      reply.provenance.files_covered = ['x.ts']
      expect(cleanReviewEvidence(runId, reply)).toMatchObject({
        failure: expect.stringContaining('intersects none'), kind: 'unevidenced',
      })

      const emptyHead = gg('rev-parse', 'HEAD')
      const emptyTree = gg('rev-parse', 'HEAD^{tree}')
      db().query('UPDATE run SET base_commit=?, input_tree=? WHERE id=?')
        .run(emptyHead, emptyTree, runId)
      const empty = cleanReviewEvidence(runId, reply)
      expect(empty).toEqual({
        failure: 'clean review changed-path coverage not checked: changed-path set is empty',
        note: null, kind: 'harness',
      })

      const notGit = mkdtempSync(join(tmpdir(), 'orch-review-not-git-'))
      upsertProject({ name: 'review-evidence-project', path: notGit })
      db().query('UPDATE run SET base_commit=?, input_tree=? WHERE id=?')
        .run(emptyHead, emptyTree, runId)
      const thrown = cleanReviewEvidence(runId, reply)
      expect(thrown).toEqual({
        failure: expect.stringContaining('changed-path coverage not checked'),
        note: null, kind: 'harness',
      })
      expect(thrown.failure === 'clean review changed-path coverage not checked: changed-path set is empty')
        .toBe(false)
      upsertProject({ name: 'review-evidence-project', path: repo })
      rmSync(notGit, { recursive: true, force: true })

      reply.findings = [{
        severity: 'major', location: 'file.ts:1', evidence: 'evidence 1',
        proposed_correction: 'fix 1',
      }]
      db().query('UPDATE run SET input_tree=NULL WHERE id=?').run(runId)
      expect(cleanReviewEvidence(runId, reply)).toEqual({ failure: null, note: null })
      reply.findings = []

      const unknown = cleanReviewEvidence(runId, reply)
      expect(unknown).toEqual({
        failure: 'clean review changed-path coverage not checked: run lacks repo, base_commit, or input_tree',
        note: null, kind: 'harness',
      })

      db().query('UPDATE run SET base_commit=?, input_tree=? WHERE id=?')
        .run(emptyHead, emptyTree, runId)
      removeProject('review-evidence-project')
      const unregistered = cleanReviewEvidence(runId, reply)
      expect(unregistered).toEqual({
        failure: 'clean review changed-path coverage not checked: project review-evidence-project is not registered',
        note: null, kind: 'harness',
      })
      upsertProject({ name: 'review-evidence-project', path: repo })

    } finally {
      removeProject('review-evidence-project')
      rmSync(repo, { recursive: true, force: true })
    }
  })
test('clean review coverage reads the recorded change path set, not run.changed_paths', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-review-path-set-')))
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
    writeFileSync(join(repo, 'kept.ts'), 'kept\n'); gg('add', '.'); gg('commit', '-m', 'change')
    upsertProject({ name: 'review-path-set-project', path: repo })
    const runId = addRun({
      agent: 'codex', job: 'review-lens', repo: 'review-path-set-project',
      lens: 'correctness', inputTree: gg('rev-parse', 'HEAD^{tree}'),
      headCommit: gg('rev-parse', 'HEAD'),
    })
    db().query('UPDATE run SET base_commit=?, changed_paths=? WHERE id=?')
      .run(gg('rev-parse', 'HEAD~1'), JSON.stringify(['kept.ts']), runId)
    const reviewId = recordReview(runId, reviewReply(1, 'high'), db())
    db().query('UPDATE review SET path_set=? WHERE id=?').run(JSON.stringify(['recorded.ts']), reviewId)
    try {
      const reply = reviewReply(0) as any
      reply.provenance.commands_run = ['bun test']
      reply.provenance.files_covered = ['recorded.ts']
      expect(cleanReviewEvidence(runId, reply)).toEqual({ failure: null, note: null })
      reply.provenance.files_covered = ['kept.ts']
      expect(cleanReviewEvidence(runId, reply)).toMatchObject({
        failure: expect.stringContaining('intersects none'), kind: 'unevidenced',
      })
    } finally {
      removeProject('review-path-set-project')
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

