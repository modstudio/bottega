// concern: worktree-tool

import { targetGitEnvironment } from '../git/git-environment.ts'
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
