/** Worktree provisioning places declared dependency paths without knowing reader or writer lifecycles. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

type ProvisionEntry = { path: string; method: 'link' | 'clone'; required?: boolean }
export type WorktreeProvision = ProvisionEntry[]
export type ReadonlyProvision = WorktreeProvision
export type ProvisionDecision = 'provision' | 'skip' | 'fail'
export type ProvisionSkip = {
  path: string
  reason: 'missing source' | 'existing target'
}

function targetExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * The deepest existing ancestor of `target` must resolve inside the tree. A
 * symlinked ancestor checked out by the branch would otherwise send the
 * provisioned copy outside the tree, where tree removal never reaches it.
 */
function escapesTree(tree: string, target: string): boolean {
  let ancestor = dirname(target)
  while (!targetExists(ancestor)) ancestor = dirname(ancestor)
  const root = realpathSync(tree)
  const resolved = realpathSync(ancestor)
  return resolved !== root && !resolved.startsWith(root + sep)
}

function linkProvision(source: string, target: string): void {
  if (!statSync(source).isDirectory()) {
    symlinkSync(relative(dirname(target), source), target)
    return
  }
  mkdirSync(target)
  for (const entry of readdirSync(source)) {
    const entryTarget = join(target, entry)
    symlinkSync(relative(dirname(entryTarget), join(source, entry)), entryTarget)
  }
}

/** Decide how one declared dependency is handled without consulting the filesystem. */
export function decideProvision(entry: ProvisionEntry, sourceExists: boolean): ProvisionDecision {
  if (sourceExists) return 'provision'
  return entry.required === true ? 'fail' : 'skip'
}

/** Place declared dependencies and report entries deliberately left alone. */
export function provisionWorktree(
  main: string,
  tree: string,
  provisions: WorktreeProvision,
): ProvisionSkip[] {
  const skipped: ProvisionSkip[] = []
  for (const provision of provisions) {
    const source = join(main, provision.path)
    const target = join(tree, provision.path)
    const decision = decideProvision(provision, existsSync(source))
    if (decision === 'fail') {
      throw new Error(
        `required provision "${provision.path}" source is missing at ${source}; install dependencies in the main checkout, or correct the register row`,
      )
    }
    if (decision === 'skip') {
      skipped.push({ path: provision.path, reason: 'missing source' })
      continue
    }
    if (targetExists(target)) {
      skipped.push({ path: provision.path, reason: 'existing target' })
      continue
    }
    if (escapesTree(tree, target)) {
      throw new Error(
        `provision "${provision.path}" resolves outside the tree through a symlinked ancestor; remove the symlink from the branch or declare a path that does not pass through it`,
      )
    }
    mkdirSync(dirname(target), { recursive: true })
    if (provision.method === 'link') {
      linkProvision(source, target)
      continue
    }
    const copy = Bun.spawnSync(['cp', '-c', '-R', source, target], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (copy.exitCode !== 0) {
      const detail = copy.stderr.toString().trim() || `cp exited ${copy.exitCode}`
      throw new Error(`could not clone provision "${provision.path}": ${detail}`)
    }
  }
  return skipped
}

function provisionPathProblem(path: string): boolean {
  return (
    !path.trim() ||
    /^[\\/]/.test(path) ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.split(/[\\/]+/).includes('..')
  )
}

/** Validate the register-owned reader declaration at its input boundary. */
export function validateReadonlyProvision(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) return ['worktree.readonly_provision must be an array']
  const problems: string[] = []
  const paths = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push('worktree.readonly_provision entries must be objects')
      continue
    }
    const candidate = entry as Record<string, unknown>
    if (typeof candidate.path !== 'string' || provisionPathProblem(candidate.path)) {
      problems.push('worktree.readonly_provision path must be a non-empty relative path without ..')
    } else if (paths.has(candidate.path)) {
      problems.push(`worktree.readonly_provision path must be unique: "${candidate.path}"`)
    } else {
      paths.add(candidate.path)
    }
    if (candidate.method !== 'link' && candidate.method !== 'clone') {
      problems.push("worktree.readonly_provision method must be 'link' or 'clone'")
    }
    if (candidate.required !== undefined && typeof candidate.required !== 'boolean') {
      problems.push('worktree.readonly_provision required must be a boolean')
    }
  }
  return problems
}
