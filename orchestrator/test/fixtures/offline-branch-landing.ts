import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '../../src/database/db.ts'

export function git(repository: string, ...args: string[]): string {
  const process = Bun.spawnSync(['git', ...args], {
    cwd: repository,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (process.exitCode !== 0) {
    throw new Error(process.stderr.toString().trim() || `git ${args.join(' ')} failed`)
  }
  return process.stdout.toString().trim()
}

export function gitRepository(name: string): string {
  const path = mkdtempSync(join(tmpdir(), `orch-offline-landing-${name}-`))
  git(path, 'init', '-b', 'main')
  git(path, 'config', 'user.name', 'Fixture')
  git(path, 'config', 'user.email', 'fixture@example.com')
  writeFileSync(join(path, 'state.txt'), 'base\n')
  git(path, 'add', 'state.txt')
  git(path, 'commit', '-m', 'base')
  return path
}

export function removeGitRepository(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

export function addProject(name: string, path: string): number {
  return (
    db()
      .query(
        `INSERT INTO project (name,path,stack,settings)
         VALUES (?,?,'bun','{"trunk":"main"}') RETURNING id`,
      )
      .get(name, path) as { id: number }
  ).id
}
