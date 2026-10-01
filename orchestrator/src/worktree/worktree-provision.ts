/** Worktree provisioning places declared dependency paths without knowing reader or writer lifecycles. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

export type ProvisionEntry = {
  path: string
  method: 'link' | 'clone'
  required?: boolean
  lockfile?: string
  install?: string
}
export type WorktreeProvision = ProvisionEntry[]
export type ReadonlyProvision = WorktreeProvision
export type ProvisionDecision = 'provision' | 'skip' | 'fail'
export type ProvisionGroupDecision = {
  action: 'provision' | 'install'
  entries: ProvisionEntry[]
}
export type ProvisionSkip = {
  path: string
  reason: 'missing source' | 'existing target'
}

const INSTALL_ENVIRONMENT_PREFIXES = ['ORCH_', 'HUB_', 'SSH_'] as const
const INSTALL_ENVIRONMENT_SECRET_MARKERS = [
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'KEY',
  'CREDENTIAL',
] as const

/** Remove orchestration context and credentials from the installer's inherited environment. */
export function installEnvironment(
  parent: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue
    const normalized = key.toUpperCase()
    if (INSTALL_ENVIRONMENT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) continue
    if (INSTALL_ENVIRONMENT_SECRET_MARKERS.some((marker) => normalized.includes(marker))) continue
    environment[key] = value
  }
  return environment
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

/** Decide one lockfile group's safe materialization without consulting the filesystem. */
export function decideProvisionGroup(
  entries: ProvisionEntry[],
  treeLockfile: string | null,
  sourceLockfile: string | null,
): ProvisionGroupDecision {
  if (sourceLockfile !== null && treeLockfile === sourceLockfile) {
    return { action: 'provision', entries }
  }
  return {
    action: 'install',
    entries: entries.map((entry) => ({ ...entry, method: 'clone' as const })),
  }
}

function placeProvision(
  main: string,
  tree: string,
  provision: ProvisionEntry,
  declarationSource: string,
  skipped: ProvisionSkip[],
): void {
  const source = join(main, provision.path)
  const target = join(tree, provision.path)
  const decision = decideProvision(provision, existsSync(source))
  if (decision === 'fail') {
    throw new Error(
      `required provision "${provision.path}" from ${declarationSource} is missing its source at ${source}; install dependencies in the main checkout, or correct ${declarationSource}`,
    )
  }
  if (decision === 'skip') {
    skipped.push({ path: provision.path, reason: 'missing source' })
    return
  }
  if (targetExists(target)) {
    skipped.push({ path: provision.path, reason: 'existing target' })
    return
  }
  if (escapesTree(tree, target)) {
    throw new Error(
      `provision "${provision.path}" resolves outside the tree through a symlinked ancestor; remove the symlink from the branch or declare a path that does not pass through it`,
    )
  }
  mkdirSync(dirname(target), { recursive: true })
  if (provision.method === 'link') {
    linkProvision(source, target)
    return
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

function lockfileContent(root: string, lockfile: string): string | null {
  const path = join(root, lockfile)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/** Refuse a checked-in target that could let the subsequent installer leave this tree. */
export function assertInstallTargetSafe(tree: string, provision: ProvisionEntry): void {
  const target = join(tree, provision.path)
  if (!targetExists(target)) return
  if (lstatSync(target).isSymbolicLink()) {
    throw new Error(
      `install-mode provision "${provision.path}" target is a symlink; refusing to run an install that could write through it`,
    )
  }
  const root = realpathSync(tree)
  const resolved = realpathSync(target)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(
      `install-mode provision "${provision.path}" target resolves outside the tree; refusing to run an install that could write there`,
    )
  }
}

function installProvisionGroup(
  tree: string,
  lockfile: string,
  install: string,
  entries: ProvisionEntry[],
  timeoutMs: number | undefined,
): void {
  const result = Bun.spawnSync(['sh', '-c', install], {
    cwd: tree,
    env: installEnvironment(process.env),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
  })
  if (result.exitCode === 0) return
  const stderr = result.stderr.toString().trim().slice(-1500) || `exit ${result.exitCode}`
  const group = entries.map((entry) => entry.path).join(', ')
  throw new Error(
    `provision group [${group}] for lockfile "${lockfile}" failed running "${install}": ${stderr}`,
  )
}

function decideProvisionGroups(
  main: string,
  tree: string,
  grouped: ReadonlyMap<string, ProvisionEntry[]>,
): Map<string, ProvisionGroupDecision> {
  const decisions = new Map<string, ProvisionGroupDecision>()
  for (const [lockfile, entries] of grouped) {
    decisions.set(
      lockfile,
      decideProvisionGroup(
        entries,
        lockfileContent(tree, lockfile),
        lockfileContent(main, lockfile),
      ),
    )
  }
  return decisions
}

function assertInstallGroupsSafe(
  tree: string,
  decisions: ReadonlyMap<string, ProvisionGroupDecision>,
): void {
  for (const decision of decisions.values()) {
    if (decision.action !== 'install') continue
    for (const entry of decision.entries) assertInstallTargetSafe(tree, entry)
  }
}

function materializeInstallGroups(
  main: string,
  tree: string,
  decisions: ReadonlyMap<string, ProvisionGroupDecision>,
  declarationSource: string,
  skipped: ProvisionSkip[],
): void {
  for (const decision of decisions.values()) {
    if (decision.action !== 'install') continue
    for (const entry of decision.entries) {
      placeProvision(main, tree, entry, declarationSource, skipped)
    }
  }
}

function runInstallGroups(
  tree: string,
  grouped: ReadonlyMap<string, ProvisionEntry[]>,
  decisions: ReadonlyMap<string, ProvisionGroupDecision>,
  timeoutMs: number | undefined,
): void {
  for (const [lockfile, decision] of decisions) {
    if (decision.action !== 'install') continue
    const entries = grouped.get(lockfile) ?? []
    installProvisionGroup(tree, lockfile, entries[0]!.install!, entries, timeoutMs)
  }
}

function placeDeferredProvisions(
  main: string,
  tree: string,
  provisions: WorktreeProvision,
  decisions: ReadonlyMap<string, ProvisionGroupDecision>,
  declarationSource: string,
  skipped: ProvisionSkip[],
): void {
  const handledGroups = new Set<string>()
  for (const provision of provisions) {
    if (!provision.lockfile) {
      placeProvision(main, tree, provision, declarationSource, skipped)
      continue
    }
    if (handledGroups.has(provision.lockfile)) continue
    handledGroups.add(provision.lockfile)
    const decision = decisions.get(provision.lockfile)!
    if (decision.action === 'install') continue
    for (const entry of decision.entries) {
      placeProvision(main, tree, entry, declarationSource, skipped)
    }
  }
}

/** Place declared dependencies and report entries deliberately left alone. */
export function provisionWorktree(
  main: string,
  tree: string,
  provisions: WorktreeProvision,
  declarationSource = 'the provision declaration',
  timeoutMs?: number,
): ProvisionSkip[] {
  const skipped: ProvisionSkip[] = []
  const grouped = new Map<string, ProvisionEntry[]>()
  for (const provision of provisions) {
    if (!provision.lockfile) continue
    const group = grouped.get(provision.lockfile) ?? []
    group.push(provision)
    grouped.set(provision.lockfile, group)
  }
  const decisions = decideProvisionGroups(main, tree, grouped)

  // Nothing may be linked into the tree while an installer can still run. Check every
  // install target first, then clone all install groups before starting any command.
  assertInstallGroupsSafe(tree, decisions)
  materializeInstallGroups(main, tree, decisions, declarationSource, skipped)
  runInstallGroups(tree, grouped, decisions, timeoutMs)

  // Once every install has finished, preserve declaration order for ordinary entries and
  // lockfile groups whose content matched the source checkout.
  placeDeferredProvisions(main, tree, provisions, decisions, declarationSource, skipped)
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

function validateLockfileProvision(
  candidate: Record<string, unknown>,
  lockfileInstalls: Map<string, string>,
): string[] {
  const problems: string[] = []
  const hasLockfile = candidate.lockfile !== undefined
  const hasInstall = candidate.install !== undefined
  const validLockfile =
    typeof candidate.lockfile === 'string' && !provisionPathProblem(candidate.lockfile)
  const validInstall = typeof candidate.install === 'string' && Boolean(candidate.install.trim())
  if (hasLockfile && !validLockfile) {
    problems.push(
      'worktree.readonly_provision lockfile must be a non-empty relative path without ..',
    )
  }
  if (hasInstall && !validInstall) {
    problems.push('worktree.readonly_provision install must be a non-empty string')
  }
  if (hasLockfile !== hasInstall) {
    problems.push('worktree.readonly_provision lockfile and install must be declared together')
  }
  if (!validLockfile || !validInstall) return problems
  const declared = lockfileInstalls.get(candidate.lockfile as string)
  if (declared !== undefined && declared !== candidate.install) {
    problems.push(
      `worktree.readonly_provision entries for lockfile "${candidate.lockfile}" must agree on install`,
    )
  } else {
    lockfileInstalls.set(candidate.lockfile as string, candidate.install as string)
  }
  return problems
}

/** Validate the register-owned reader declaration at its input boundary. */
export function validateReadonlyProvision(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) return ['worktree.readonly_provision must be an array']
  const problems: string[] = []
  const paths = new Set<string>()
  const lockfileInstalls = new Map<string, string>()
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
    problems.push(...validateLockfileProvision(candidate, lockfileInstalls))
  }
  return problems
}
