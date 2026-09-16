// concern: checkout-identity
/**
 * Knows checkout paths, aliases, case sensitivity, and confinement watch sets.
 * Must not know databases, worktree lifecycle, run state, or routing.
 */
import { realpathSync, statSync } from 'node:fs'
import { dirname, sep } from 'node:path'
import { targetGitEnvironment } from './git-environment.ts'
import { projects } from './projects.ts'

/** Preserve the root separator while removing spelling-only trailing separators. */
export function withoutTrailingSeparators(path: string): string {
  let end = path.length
  while (end > 1 && path[end - 1] === sep) end--
  return path.slice(0, end)
}

/** Use physical identity where it is available, and the recorded spelling otherwise. */
export function realpathOrSpelled(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export type CheckoutAliases = {
  roots: string[]
  caseInsensitive: boolean
  diagnostic: string | null
}

export type CheckoutToWatch = { project: string; path: string; expectedHead?: string | null }
export type CheckoutWatchFailure = CheckoutToWatch & { error: string }

function checkoutRootAsAddressed(cwd: string): string | null {
  try {
    const p = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', '--show-prefix'], {
      env: targetGitEnvironment(cwd),
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (p.exitCode !== 0) return null
    const prefix = new TextDecoder().decode(p.stdout).trim()
    let root = cwd
    for (const _segment of prefix.split('/').filter(Boolean)) root = dirname(root)
    return root
  } catch {
    return null
  }
}

function gitTopLevel(cwd: string): string | null {
  try {
    const p = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], {
      env: targetGitEnvironment(cwd),
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (p.exitCode !== 0) return null
    return new TextDecoder().decode(p.stdout).trim() || null
  } catch {
    return null
  }
}

function flipOneAsciiLetter(value: string): string | null {
  let index = -1
  for (let candidate = value.length - 1; candidate >= 0; candidate--) {
    if (/[A-Za-z]/.test(value[candidate]!)) {
      index = candidate
      break
    }
  }
  if (index === -1) return null
  const letter = value[index]!
  const flipped = letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()
  return value.slice(0, index) + flipped + value.slice(index + 1)
}

export function checkoutAliases(cwd: string): CheckoutAliases | null {
  const addressed = checkoutRootAsAddressed(cwd)
  const top = gitTopLevel(cwd)
  if (!addressed || !top) return null
  let canonical: string
  try {
    canonical = realpathSync(addressed)
  } catch {
    canonical = top
  }
  const roots = [...new Set([addressed, top, canonical])]
  return { roots, ...checkoutCaseSensitivity(addressed) }
}

function checkoutCaseSensitivity(root: string): Omit<CheckoutAliases, 'roots'> {
  const variant = flipOneAsciiLetter(root)
  let caseInsensitive = false
  let diagnostic: string | null = null
  const partialFoldLimit =
    'path matching uses a partial Unicode case fold; filesystem-specific folding beyond it is a known limit'
  if (!variant) {
    diagnostic =
      `checkout case-sensitivity probe indeterminate: root has no alphabetic character ` +
      `(${root}); ${partialFoldLimit}`
  } else {
    try {
      const original = statSync(root)
      const changed = statSync(variant)
      caseInsensitive = original.dev === changed.dev && original.ino === changed.ino
    } catch {
      diagnostic =
        `checkout case-sensitivity probe indeterminate: could not stat case variant of ` +
        `${root}; ${partialFoldLimit}`
    }
  }
  return { caseInsensitive, diagnostic }
}

/**
 * The checkouts a run is confined against: the registered main checkout of
 * the run's OWN project, plus the caller checkout it was dispatched from.
 *
 * A change in an unrelated registered project is not this run's escape. The
 * own-project and caller scope prevents unrelated sessions from becoming
 * adversaries while retaining the two checkouts this run can affect.
 * `ownProject` null (no project resolved) keeps the wide set, since
 * an unregistered caller has no narrower fact to stand on.
 */
export function checkoutWatchSet(
  additional: CheckoutToWatch[] = [],
  activeWorktree?: string,
  ownProject: string | null | undefined = undefined,
): { watched: CheckoutToWatch[]; failures: CheckoutWatchFailure[] } {
  const active = activeWorktree ? realpathSync(activeWorktree) : null
  const watched: CheckoutToWatch[] = []
  const failures: CheckoutWatchFailure[] = []
  const seen = new Set<string>()
  const registered = projects().filter(
    ({ name }) => ownProject === undefined || ownProject === null || name === ownProject,
  )
  for (const checkout of [
    ...registered.map(({ name, path, settings }) => ({
      project: name,
      path,
      expectedHead: typeof settings.trunk === 'string' ? settings.trunk : null,
    })),
    ...additional,
  ]) {
    let canonical: string
    try {
      canonical = realpathSync(checkout.path)
    } catch (error) {
      failures.push({
        ...checkout,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    if (canonical === active || seen.has(canonical)) continue
    seen.add(canonical)
    watched.push({
      project: checkout.project,
      path: canonical,
      expectedHead: checkout.expectedHead ?? null,
    })
  }
  return { watched, failures }
}
