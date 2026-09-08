import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS, dir, hermeticGitEnv, runJob } from '../test/fixture.ts'

describe('issue blast-radius review tree', () => {
  test('a carried review launched from the fix worktree receives the committed fix tree', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-issue-review-tree-'))
    const fixTree = mkdtempSync(join(tmpdir(), 'orch-issue-fix-tree-'))
    const script = join(dir, 'report-review-tree.ts')
    const agent = AGENTS.codex!
    const original = {
      bin: agent.bin, argv: agent.argv, stdin: agent.stdin,
      readsOut: agent.readsOut, parseReply: agent.parseReply,
    }
    const oldDepth = process.env.ORCH_DEPTH
    const runGit = (cwd: string, ...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      runGit(repo, 'init', '-b', 'main')
      runGit(repo, 'config', 'user.email', 'orch-test@example.invalid')
      runGit(repo, 'config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'reviewed.txt'), 'trunk\n')
      runGit(repo, 'add', 'reviewed.txt')
      runGit(repo, 'commit', '-m', 'DEV-261 fixture trunk')
      const trunkHead = runGit(repo, 'rev-parse', 'HEAD')
      runGit(repo, 'worktree', 'add', '-b', 'DEV-261-fix', fixTree)
      writeFileSync(join(fixTree, 'reviewed.txt'), 'fix\n')
      runGit(fixTree, 'add', 'reviewed.txt')
      runGit(fixTree, 'commit', '-m', 'DEV-261 fixture fix')
      const fixHead = runGit(fixTree, 'rev-parse', 'HEAD')
      writeFileSync(script, [
        "const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { stdout: 'pipe' }).stdout.toString().trim()",
        "const inspected = { head: git('rev-parse', 'HEAD'), diff: git('diff', 'HEAD', '--', 'reviewed.txt') }",
        "console.log(JSON.stringify({ findings: [{ severity: 'major', location: 'reviewed.txt:1', evidence: JSON.stringify(inspected), proposed_correction: 'fixture correction' }], provenance: { tree_inspected: inspected.head, standards_read: ['AGENTS.md'], model_used: 'fixture', files_covered: ['reviewed.txt'], commands_run: ['git rev-parse HEAD', 'git diff HEAD -- reviewed.txt'], mcp_tools: [], docs_read: [], could_not_verify: [], substitutes: [], canon_source: 'repo fallback' } }))",
      ].join('\n'))
      agent.bin = process.execPath
      agent.argv = () => [script]
      agent.stdin = true
      agent.readsOut = false
      agent.parseReply = undefined
      process.env.ORCH_DEPTH = '0'

      const fromProject = await runJob({
        job: 'review-lens', prompt: 'inspect the fix', cwd: repo,
        agent: 'codex', lens: 'issue-blast-radius', key: 'DEV-261',
      })
      const review = await runJob({
        job: 'review-lens', prompt: 'inspect the fix', cwd: fixTree,
        agent: 'codex', lens: 'issue-blast-radius', key: 'DEV-261', carry: true,
      })
      const projectReply = JSON.parse(fromProject.output) as { findings: Array<{ evidence: string }> }
      const reviewReply = JSON.parse(review.output) as { findings: Array<{ evidence: string }> }
      const projectReceived = JSON.parse(projectReply.findings[0]!.evidence) as { head: string; diff: string }
      const received = JSON.parse(reviewReply.findings[0]!.evidence) as { head: string; diff: string }
      expect(projectReceived).toEqual({ head: trunkHead, diff: '' })
      expect(received).toEqual({ head: fixHead, diff: '' })
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.stdin = original.stdin
      agent.readsOut = original.readsOut
      agent.parseReply = original.parseReply
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
      rmSync(repo, { recursive: true, force: true })
      rmSync(fixTree, { recursive: true, force: true })
      rmSync(script, { force: true })
    }
  })
})
