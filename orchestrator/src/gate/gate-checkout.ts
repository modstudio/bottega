// concern: worker gate checkout
/** Observes checkout state that makes a gate unsafe to run. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { startBoundedSync } from '../../../shared/bounded-process.ts'
import { inspectionGitEnv } from '../../../shared/git.ts'
import { nulPathListArgs, splitNulPaths } from '../../../shared/git-path-list.ts'
import { decideGateCheckoutRefusal, GATE_CHECKOUT_OPERATION_MARKERS } from './gate-decision.ts'

export type GateCheckoutObserver = (cwd: string) => {
  presentMarkers: readonly string[]
  unmergedPaths: readonly string[]
}

type GitCommandResult = {
  status: number | null
  stderr?: string
  error?: Error
}

export function gitCommandError(cwd: string, result: GitCommandResult, action: string): string {
  const detail = result.error
    ? existsSync(cwd)
      ? `${result.error.name}: ${result.error.message}`
      : 'checkout path does not exist'
    : result.stderr?.trim()
  return `${PLATFORM_SLUG} gate run needs ${action} in ${cwd}: ${detail || `git exited ${result.status}`}`
}

function uniqueUnmergedPaths(stdout: string): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const entry of splitNulPaths(stdout)) {
    const tab = entry.lastIndexOf('\t')
    const path = tab === -1 ? entry : entry.slice(tab + 1)
    if (!path || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}

function observeGateCheckoutFacts(cwd: string): {
  presentMarkers: string[]
  unmergedPaths: string[]
} {
  let gitDir: ReturnType<typeof startBoundedSync>
  try {
    gitDir = startBoundedSync(['git', 'rev-parse', '--path-format=absolute', '--git-dir'], {
      budget: 'git-plumbing',
      cwd,
      env: inspectionGitEnv(),
    })
  } catch (error) {
    throw new Error(
      gitCommandError(cwd, { status: null, error: error as Error }, 'git dir'),
    )
  }
  if (gitDir.exitCode !== 0)
    throw new Error(gitCommandError(cwd, { ...gitDir, status: gitDir.exitCode }, 'git dir'))
  const dir = gitDir.stdout.trim()
  const presentMarkers = GATE_CHECKOUT_OPERATION_MARKERS.filter((marker) =>
    existsSync(join(dir, marker)),
  )
  const unmerged = startBoundedSync(['git', ...nulPathListArgs(['ls-files', '-u'])], {
    budget: 'git-plumbing',
    cwd,
    env: inspectionGitEnv(),
  })
  if (unmerged.exitCode !== 0)
    throw new Error(
      gitCommandError(cwd, { ...unmerged, status: unmerged.exitCode }, 'git ls-files'),
    )
  return {
    presentMarkers: [...presentMarkers],
    unmergedPaths: uniqueUnmergedPaths(unmerged.stdout),
  }
}

export function refuseInProgressCheckout(
  cwd: string,
  observe: GateCheckoutObserver = observeGateCheckoutFacts,
): void {
  const refusal = decideGateCheckoutRefusal(observe(cwd))
  if (refusal) throw new Error(`${PLATFORM_SLUG} gate run: ${refusal}`)
}
