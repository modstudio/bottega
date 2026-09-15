// concern: worktree-tool

import { targetGitEnvironment } from './git-environment.ts'
import { fillTool } from './worktree-template.ts'

export function runShellTool(
  template: string,
  vars: Record<string, string>,
  cwd: string,
): { ok: boolean; out: string; stdout: string; exitCode: number | null } {
  const cmd = fillTool(template, vars)
  const p = Bun.spawnSync(['sh', '-c', cmd], {
    cwd,
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = p.stdout.toString()
  const out = `${stdout}${p.stderr.toString()}`.trim()
  return { ok: p.exitCode === 0, out, stdout, exitCode: p.exitCode }
}

/**
 * A port nothing else on this machine is using, derived from the run id.
 *
 * Derived rather than allocated, so it is the same on every read — a caller
 * that has to ask twice must get the same answer, or a worker serves on one
 * port and something else fetches from another. The range is high enough to
 * miss the usual development ports and wide enough that collisions between
 * concurrent runs are rare rather than impossible; a project needing a
 * guaranteed-free port allocates its own in its recipe.
 */
export function portFor(runId: number): number {
  return 21000 + (runId % 4000)
}
