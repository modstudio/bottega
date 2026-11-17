import { expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { register as registerReviewCommand } from '../commands/review.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'

function git(repo: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

async function runReview(argv: string[], output: string[]): Promise<void> {
  const program = new Command().exitOverride()
  registerReviewCommand(program, { log: (...values) => output.push(values.join(' ')) })
  await program.parseAsync(['node', 'orch', ...argv])
}

test('review tier resolves a task key and distinguishes missing task branches from unknown targets', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'orch-review-tier-task-key-'))
  try {
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.email', 'fixture@example.com')
    git(repo, 'config', 'user.name', 'Fixture')
    git(repo, 'remote', 'add', 'origin', 'https://github.com/example/example.git')
    writeFileSync(join(repo, 'base.ts'), 'export const base = true\n')
    git(repo, 'add', 'base.ts')
    git(repo, 'commit', '-m', 'base')
    const branch = 'DEV-2403-tier-target'
    git(repo, 'checkout', '-b', branch)
    writeFileSync(join(repo, 'change.ts'), 'export const change = true\n')
    git(repo, 'add', 'change.ts')
    git(repo, 'commit', '-m', 'change')
    const project = `tier-task-key-${crypto.randomUUID()}`
    const projectId = newRecordId()
    upsertProject({
      recordId: projectId,
      name: project,
      path: repo,
      settings: { trunk: 'main', review: { lenses: [{ lens: 'correctness' }] } },
    })
    db()
      .query(
        `INSERT INTO run
         (record_id,number,started_at,agent,job,repo,project_record_id,prompt_sha,prompt_bytes,
          prompt_head,status,branch,launch_key,turn)
         VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-11-17','codex','implement',?,?,
                 'sha',1,'task-key tier target','ok',?,'DEV-2403',1)`,
      )
      .run(newRecordId(), project, projectId, branch)
    const originalSpawnSync = Bun.spawnSync
    spyOn(Bun, 'spawnSync').mockImplementation(((args: string[], options?: object) => {
      if (args[0] !== 'gh') return originalSpawnSync(args, options as never)
      return {
        exitCode: 0,
        stdout: Buffer.from('[]'),
        stderr: Buffer.from(''),
        success: true,
        exitedDueToTimeout: false,
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync)
    const output: string[] = []

    await runReview(['review', 'tier', 'DEV-2403', '--cwd', repo], output)

    expect(output).toContain('lens correctness  framework=generic  reason: initial')
    await expect(runReview(['review', 'tier', 'DEV-999', '--cwd', repo], [])).rejects.toThrow(
      `task DEV-999 has no unlanded branch; pass its branch or run id to \`${PLATFORM_SLUG} review tier\``,
    )
    await expect(runReview(['review', 'tier', 'UNKNOWN', '--cwd', repo], [])).rejects.toThrow(
      'review tier accepts a branch, task key, run id, or explicit <from>..<to> range',
    )
  } finally {
    mock.restore()
    rmSync(repo, { recursive: true, force: true })
  }
})
