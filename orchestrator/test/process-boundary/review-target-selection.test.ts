import { describe,expect,test } from 'bun:test'
import { existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS,addRun,completeReview,contentTree,coverageAudit,db,dir,hermeticGitEnv,implicitReviewWarning,resolveReviewTarget,reviewReply,runJob,upsertProject } from '../fixture.ts'

describe('review-lens-inline has no checkout', () => {
test('explicit review refs select and record the reviewed branch tip', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-explicit-review-'))
    const branchTree = join(repo, 'feature-tree')
    const script = join(dir, 'report-explicit-review.ts')
    const agent = AGENTS.codex!
    const original = {
      bin: agent.bin, argv: agent.argv, stdin: agent.stdin,
      readsOut: agent.readsOut, parseReply: agent.parseReply,
    }
    const oldDepth = process.env.ORCH_DEPTH
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
      writeFileSync(join(repo, 'subject.txt'), 'trunk\n')
      git(repo, 'add', 'subject.txt')
      git(repo, 'commit', '-m', 'fixture trunk')
      git(repo, 'worktree', 'add', '-b', 'feature/reviewed', branchTree)
      writeFileSync(join(branchTree, 'subject.txt'), 'branch\n')
      git(branchTree, 'add', 'subject.txt')
      git(branchTree, 'commit', '-m', 'fixture branch')
      const tip = git(repo, 'rev-parse', 'feature/reviewed^{commit}')
      const tree = git(repo, 'rev-parse', 'feature/reviewed^{tree}')
      upsertProject({ name: 'explicit-review-fixture', path: repo, settings: { trunk: 'main' } })
      writeFileSync(script, [
        "const view = { cwd: process.cwd(), text: await Bun.file('subject.txt').text() }",
        `const reply = ${JSON.stringify(reviewReply(0))}`,
        "reply.provenance.files_covered = ['subject.txt']",
        "reply.provenance.docs_read = [JSON.stringify(view)]",
        "console.log(JSON.stringify(reply))",
      ].join('\n'))
      agent.bin = process.execPath
      agent.argv = () => [script]
      agent.stdin = false
      agent.readsOut = false
      agent.parseReply = undefined
      process.env.ORCH_DEPTH = '0'

      const byBranch = await runJob({
        job: 'review-lens', prompt: 'inspect', cwd: repo, agent: 'codex',
        lens: 'explicit', review: 'feature/reviewed', keepTree: true,
      })
      expect(git(byBranch.worktree!.path, 'rev-parse', 'HEAD')).toBe(tip)
      expect(Bun.spawnSync(['git', 'symbolic-ref', '-q', 'HEAD'], {
        cwd: byBranch.worktree!.path, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      }).exitCode).not.toBe(0)
      expect(JSON.parse(JSON.parse(byBranch.output).provenance.docs_read[0]).text).toBe('branch\n')
      expect(db().query(
        'SELECT branch, base_commit, input_tree, head_commit, review_ref FROM run WHERE id=?',
      ).get(byBranch.id)).toEqual({
        branch: 'feature/reviewed', base_commit: git(repo, 'rev-parse', 'main'),
        input_tree: tree, head_commit: tip, review_ref: 'feature/reviewed',
      })
      const explicitReview = (db().query('SELECT review_id FROM review_lens WHERE run_id=?').get(byBranch.id) as
        { review_id: number }).review_id
      completeReview(explicitReview)
      expect(coverageAudit()).toEqual({ count: 0, review_ids: [], partial_review_ids: [] })

      const sourceRun = addRun({ agent: 'codex', job: 'implement' })
      db().query('UPDATE run SET branch=? WHERE id=?').run('feature/reviewed', sourceRun)
      const byRun = await runJob({
        job: 'craft', prompt: 'inspect', cwd: repo, agent: 'codex',
        lens: 'by-run', review: String(sourceRun), keepTree: true,
      })
      expect(git(byRun.worktree!.path, 'rev-parse', 'HEAD')).toBe(tip)
      expect(db().query('SELECT review_ref FROM run WHERE id=?').get(byRun.id))
        .toEqual({ review_ref: String(sourceRun) })

      expect(() => resolveReviewTarget('implement', repo, 'feature/reviewed'))
        .toThrow('--review is only valid')
      expect(() => resolveReviewTarget('review-lens', repo, 'feature/reviewed', true))
        .toThrow("run --carry from that branch's own worktree")

      writeFileSync(join(branchTree, 'overlay.txt'), 'overlay\n')
      const carried = await runJob({
        job: 'safety', prompt: 'inspect', cwd: branchTree, agent: 'codex',
        lens: 'carried-review', review: 'feature/reviewed', carry: true, keepTree: true,
      })
      expect(readFileSync(join(carried.worktree!.path, 'overlay.txt'), 'utf8')).toBe('overlay\n')
      expect(git(carried.worktree!.path, 'rev-parse', 'HEAD')).toBe(tip)
      const oldObjectDirectory = process.env.GIT_OBJECT_DIRECTORY
      const oldAlternates = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES
      const expectedWarning = `reviewing main at ${git(repo, 'rev-parse', 'HEAD').slice(0, 8)}; pass --review <branch> to be explicit`
      expect(implicitReviewWarning(repo)).toBe(expectedWarning)
      process.env.GIT_OBJECT_DIRECTORY = '/foreign/object-directory'
      process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = '/foreign/alternates'
      try {
        expect(implicitReviewWarning(repo)).toContain(`at ${git(repo, 'rev-parse', 'HEAD').slice(0, 8)};`)
      } finally {
        if (oldObjectDirectory === undefined) delete process.env.GIT_OBJECT_DIRECTORY
        else process.env.GIT_OBJECT_DIRECTORY = oldObjectDirectory
        if (oldAlternates === undefined) delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES
        else process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = oldAlternates
      }

    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.stdin = original.stdin
      agent.readsOut = original.readsOut
      agent.parseReply = original.parseReply
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
      rmSync(repo, { recursive: true, force: true })
      rmSync(script, { force: true })
    }
  })
test('runs from an empty directory while review-lens still receives the project tree', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-inline-boundary-'))
    const script = join(dir, 'report-worker-cwd.ts')
    const agent = AGENTS.codex!
    const original = {
      bin: agent.bin, argv: agent.argv, stdin: agent.stdin,
      readsOut: agent.readsOut, parseReply: agent.parseReply,
    }
    const oldDepth = process.env.ORCH_DEPTH
    const runGit = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      runGit('init', '-b', 'main')
      runGit('config', 'user.email', 'orch-test@example.invalid')
      runGit('config', 'user.name', 'Orch Test')
      mkdirSync(join(repo, 'subdir'))
      writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n')
      writeFileSync(join(repo, 'project-only.txt'), 'wrong tree evidence\n')
      writeFileSync(join(repo, 'subdir', 'subject.txt'), 'nested evidence\n')
      runGit('add', '.gitignore', 'project-only.txt', 'subdir/subject.txt')
      runGit('commit', '-m', 'fixture')
      writeFileSync(script, [
        "import { existsSync, readFileSync, statSync } from 'node:fs'",
        "const prompt = await Bun.stdin.text()",
        "let plantedMcp = false",
        "try { plantedMcp = readFileSync('.mcp.json', 'utf8').includes('STALE_TRUST') } catch {}",
        "const view = {",
        "  cwd: process.cwd(),",
        "  prompt,",
        "  checkout: existsSync('.git'),",
        "  projectFile: existsSync('project-only.txt'),",
        "  plantedMcp,",
        "  mode: statSync('.').mode & 0o777,",
        "  parentMode: statSync('..').mode & 0o777,",
        "  receivedPack: prompt.includes('SELF_CONTAINED_FACT'),",
        "}",
        "if (prompt.includes('CAPTURE_NO_REPO')) { console.log(JSON.stringify(view)); process.exit(0) }",
        `const reply = ${JSON.stringify(reviewReply(1))}`,
        "reply.findings[0].evidence = JSON.stringify(view)",
        "console.log(JSON.stringify(reply))",
      ].join('\n'))
      agent.bin = process.execPath
      agent.argv = () => [script]
      agent.stdin = true
      agent.readsOut = false
      agent.parseReply = undefined
      process.env.ORCH_DEPTH = '0'

      const inline = await runJob({
        job: 'review-lens-inline', prompt: 'SELF_CONTAINED_FACT', cwd: repo, agent: 'codex', lens: 'inline',
      })
      const inlineView = JSON.parse(JSON.parse(inline.output).findings[0].evidence) as {
        cwd: string; prompt: string; checkout: boolean; projectFile: boolean
        mode: number; parentMode: number; receivedPack: boolean
      }
      expect(inlineView.checkout).toBe(false)
      expect(inlineView.projectFile).toBe(false)
      expect(inlineView.mode).toBe(0o700)
      expect(inlineView.parentMode).toBe(0o700)
      expect(inlineView.receivedPack).toBe(true)
      expect(inlineView.cwd).toContain(`/isolates/${inline.id}`)
      expect(existsSync(inlineView.cwd)).toBe(false)
      expect(inline.worktree).toBeNull()
      expect(db().query('SELECT input_tree, head_commit FROM run WHERE id=?').get(inline.id))
        .toEqual({ input_tree: null, head_commit: null })

      // Recreate the exact removed pathname and plant the trust-triggering
      // filename from the incident. A later run id must select a different
      // pathname rather than inheriting anything from this one.
      mkdirSync(inlineView.cwd, { recursive: true })
      writeFileSync(join(inlineView.cwd, '.mcp.json'), 'STALE_TRUST\n')

      const isolatePaths = new Set([inlineView.cwd])
      for (const job of ['summarize', 'mcp-query'] as const) {
        const isolated = await runJob({
          job, prompt: 'CAPTURE_NO_REPO', cwd: repo, agent: 'codex', noFailover: true,
        })
        const view = JSON.parse(isolated.output) as {
          cwd: string; checkout: boolean; projectFile: boolean
          plantedMcp: boolean; mode: number; parentMode: number
        }
        expect(view.cwd).toContain(`/isolates/${isolated.id}`)
        expect(view.cwd).not.toBe(inlineView.cwd)
        expect(view.checkout).toBe(false)
        expect(view.projectFile).toBe(false)
        expect(view.plantedMcp).toBe(false)
        expect(view.mode).toBe(0o700)
        expect(view.parentMode).toBe(0o700)
        expect(isolatePaths.has(view.cwd)).toBe(false)
        isolatePaths.add(view.cwd)
        expect(existsSync(view.cwd)).toBe(false)
        expect(isolated.worktree).toBeNull()
        expect(db().query('SELECT cwd, worktree, input_tree, head_commit FROM run WHERE id=?').get(isolated.id))
          .toEqual({
            cwd: expect.stringContaining(`/isolates/${isolated.id}`),
            worktree: null, input_tree: null, head_commit: null,
          })
      }
      expect(isolatePaths.size).toBe(3)

      const repository = await runJob({
        job: 'review-lens', prompt: `inspect ${repo}/project-only.txt`,
        cwd: repo, agent: 'codex', lens: 'project', keepTree: true,
      })
      const repositoryView = JSON.parse(JSON.parse(repository.output).findings[0].evidence) as {
        prompt: string; checkout: boolean; projectFile: boolean
      }
      expect(repositoryView.checkout).toBe(true)
      expect(repositoryView.projectFile).toBe(true)
      expect(repository.worktree?.path).toBeTruthy()
      expect(repositoryView.prompt).toContain(`${repository.worktree!.path}/project-only.txt`)
      expect(repositoryView.prompt).not.toContain(`${repo}/project-only.txt`)
      expect(db().query('SELECT input_tree, head_commit FROM run WHERE id=?').get(repository.id))
        .toEqual({
          input_tree: runGit('rev-parse', 'HEAD^{tree}'),
          head_commit: runGit('rev-parse', 'HEAD^{commit}'),
        })

      const nested = await runJob({
        job: 'review-lens', prompt: `inspect ${repo}/subdir/subject.txt`,
        cwd: join(repo, 'subdir'), agent: 'codex', lens: 'nested', keepTree: true,
      })
      const nestedView = JSON.parse(JSON.parse(nested.output).findings[0].evidence) as { prompt: string }
      expect(nestedView.prompt).toContain(`${nested.worktree!.path}/subdir/subject.txt`)
      expect(nestedView.prompt).not.toContain(`${nested.worktree!.path}/subject.txt`)

      writeFileSync(join(repo, 'project-only.txt'), 'carried tracked evidence\n')
      writeFileSync(join(repo, 'carried.txt'), 'carried untracked evidence\n')
      writeFileSync(join(repo, 'ignored.txt'), 'must not enter the tree\n')
      const callerIndex = runGit('write-tree')
      const carried = await runJob({
        job: 'review-lens', prompt: 'inspect carried content', cwd: repo, agent: 'codex',
        lens: 'carried', carry: true, keepTree: true,
      })
      const expected = contentTree(carried.worktree!.path)
      expect(db().query('SELECT input_tree, head_commit FROM run WHERE id=?').get(carried.id))
        .toEqual({ input_tree: expected, head_commit: runGit('rev-parse', 'HEAD^{commit}') })
      expect(runGit('write-tree')).toBe(callerIndex)
      expect(readFileSync(join(carried.worktree!.path, 'project-only.txt'), 'utf8'))
        .toBe('carried tracked evidence\n')
      expect(readFileSync(join(carried.worktree!.path, 'carried.txt'), 'utf8'))
        .toBe('carried untracked evidence\n')
      expect(existsSync(join(carried.worktree!.path, 'ignored.txt'))).toBe(false)
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.stdin = original.stdin
      agent.readsOut = original.readsOut
      agent.parseReply = original.parseReply
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
      rmSync(repo, { recursive: true, force: true })
      const inlineRows = db().query(
        "SELECT cwd FROM run WHERE job IN ('review-lens-inline', 'summarize', 'mcp-query') AND cwd LIKE '%/isolates/%'",
      ).all() as { cwd: string }[]
      for (const row of inlineRows) rmSync(row.cwd, { recursive: true, force: true })
      rmSync(script, { force: true })
    }
  })
})

