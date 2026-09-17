// concern: worktree-preflight
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { targetGitEnvironment } from '../git-environment.ts'
import { projectAt, resolvedWorktreeTool, type WorktreeTool } from '../project/projects.ts'
import { seedArgv, type WorktreeCreate } from './worktree-template.ts'

function executableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Resolve a structured create command exactly as its direct spawn will. */
export function createCommandExists(create: WorktreeCreate | string, repoRoot: string): boolean {
  if (typeof create === 'string' || !('command' in create)) return true
  const command = create.command
  if (command.includes('/')) return executableFile(resolve(repoRoot, command))
  return (process.env.PATH ?? '')
    .split(delimiter)
    .some((entry) => executableFile(resolve(repoRoot, entry || '.', command)))
}

/** The project's own worktree tool, if it declared one. */
export function toolFor(cwd: string): WorktreeTool | null {
  return resolvedWorktreeTool(projectAt(cwd))
}

/**
 * Ask the PROJECT'S OWN worktree tool whether a seed can succeed.
 *
 * `scripts/worktree resolve` is a capability, not a requirement of every
 * project tool. The tool's usage text is its declaration that the subcommand
 * exists; an older tool with no resolver gets no invented verdict from orch.
 *
 * The argv after `resolve` is seedArgv of the create declaration: the same words
 * the create command will pass. That is not orch parsing the seed
 * grammar — it is delivering the spec the way the project declared it wants
 * the spec delivered.
 */
export function validateSeedWithTool(cwd: string, seed?: string): void {
  if (!seed) return
  // projectAt resolves a caller inside a nested worktree back to the registered
  // main checkout, which is where the lifecycle tool and its live config live.
  const project = projectAt(cwd)
  const repoRoot = project?.path
  if (!repoRoot) return
  const worktreeTool = join(repoRoot, 'scripts', 'worktree')
  // This legacy resolver probe stays deliberately optional. Dispatch command
  // availability is enforced separately in preflight; changing this silent
  // return would make seed resolution a new required capability.
  if (!existsSync(worktreeTool)) return

  const usage = Bun.spawnSync([worktreeTool], {
    cwd: repoRoot,
    env: targetGitEnvironment(repoRoot),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const advertised = `${usage.stdout.toString()}${usage.stderr.toString()}`
  if (!/scripts\/worktree resolve(?:\s|\[)/.test(advertised)) return

  const resolved = Bun.spawnSync(
    [worktreeTool, 'resolve', ...seedArgv(project.settings.worktree?.create, seed)],
    { cwd: repoRoot, env: targetGitEnvironment(repoRoot), stdout: 'pipe', stderr: 'pipe' },
  )
  if (resolved.exitCode === 0) return
  const out = `${resolved.stdout.toString()}${resolved.stderr.toString()}`.trim()
  const detail = out ? `:\n${out.slice(-1500)}` : ` (exit ${resolved.exitCode ?? 1})`
  if (resolved.exitCode === 2) {
    throw new Error(`the project's seed resolver rejected the seed${detail}`)
  }
  throw new Error(`the project's seed resolver rejected the seed or could not check it${detail}`)
}

/**
 * Cut a worktree using the PROJECT'S OWN tool.
 *
 * Not an optimisation and not politeness. In these repositories a checkout is a
 * running application — a generated `.env`, a cloned vendor tree, a database at
 * a chosen size, a port, a queue worker — and their own script says what a bare
 * `git worktree add` leaves you with: no .env, no vendor, compose interpolating
 * to nothing, and not one quality gate able to run. A worker handed that
 * directory runs tests that are meaningless and reports them green.
 *
 * The seed is REQUIRED where the project lists seeds, because the project
 * requires it — one application removed its default after discovering the default was
 * silent and left every business table empty. orch will not reinstate by
 * omission a default that was deliberately removed.
 */
