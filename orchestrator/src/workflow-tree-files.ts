// concern: workflow-tree-files
/** Knows workflow-tree filesystem collection and application. Must not know stores, commands, projects, runs, or transports. */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { inspectionGitEnv } from '../../shared/git.ts'
import type { WorkflowTreeFile, WorkflowTreePlan } from './workflow-tree.ts'

export function workflowGitRoot(cwd: string): string {
  const result = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: inspectionGitEnv(),
  })
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim()
    throw new Error(`git -C ${cwd} rev-parse --show-toplevel failed${detail ? `: ${detail}` : ''}`)
  }
  return result.stdout.toString().trim()
}

export function collectWorkflowTree(root: string): WorkflowTreeFile[] {
  const files: WorkflowTreeFile[] = []
  for (const folder of ['steps', 'flows']) {
    const directory = resolve(root, 'workflows', folder)
    if (!existsSync(directory)) continue
    for (const name of readdirSync(directory)
      .filter((entry) => entry.endsWith('.md'))
      .sort()) {
      const path = `workflows/${folder}/${name}`
      files.push({ path, body: readFileSync(resolve(root, path), 'utf8') })
    }
  }
  return files
}

export function applyWorkflowTreePlan(root: string, plan: WorkflowTreePlan): void {
  for (const path of plan.deletes) rmSync(resolve(root, path))
  for (const { path, body } of plan.writes) {
    const target = resolve(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
  }
}
