/** Read-only provisioning knows declared file placement between a main checkout and its disposable tree. It must not know projects, run control, worker contracts, databases, ports, environments, or teardown. */
import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

export type ReadonlyProvisionEntry = { path: string; method: 'link' | 'clone' }
export type ReadonlyProvision = ReadonlyProvisionEntry[]

function targetExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Place dependencies that must exist before a read-only sandbox starts. */
export function provisionReadOnlyTree(
  main: string,
  tree: string,
  provisions: ReadonlyProvision,
): void {
  for (const provision of provisions) {
    const source = join(main, provision.path)
    const target = join(tree, provision.path)
    if (!existsSync(source) || targetExists(target)) continue
    mkdirSync(dirname(target), { recursive: true })
    if (provision.method === 'link') {
      mkdirSync(target)
      for (const entry of readdirSync(source)) {
        symlinkSync(join(source, entry), join(target, entry))
      }
      continue
    }
    const copy = Bun.spawnSync(['cp', '-c', '-R', source, target], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (copy.exitCode !== 0) {
      throw new Error(copy.stderr.toString().trim() || `cp exited ${copy.exitCode}`)
    }
  }
}

/** Validate the register-owned declaration at its input boundary. */
export function validateReadonlyProvision(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) return ['worktree.readonly_provision must be an array']
  const problems: string[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push('worktree.readonly_provision entries must be objects')
      continue
    }
    const candidate = entry as Record<string, unknown>
    if (
      typeof candidate.path !== 'string' ||
      !candidate.path.trim() ||
      isAbsolute(candidate.path) ||
      candidate.path.split('/').includes('..')
    ) {
      problems.push('worktree.readonly_provision path must be a non-empty relative path without ..')
    }
    if (candidate.method !== 'link' && candidate.method !== 'clone') {
      problems.push("worktree.readonly_provision method must be 'link' or 'clone'")
    }
  }
  return problems
}
