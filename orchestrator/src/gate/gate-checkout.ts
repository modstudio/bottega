// concern: worker gate checkout
/** Observes checkout state that makes a gate unsafe to run. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { gitAt } from '../../../shared/git.ts'
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
  let gitDir: ReturnType<typeof gitAt>
  try {
    if (!existsSync(cwd)) throw new Error('checkout path does not exist')
    gitDir = gitAt(cwd, ['rev-parse', '--path-format=absolute', '--git-dir'])
  } catch (error) {
    throw new Error(gitCommandError(cwd, { status: null, error: error as Error }, 'git dir'))
  }
  if (gitDir.code !== 0)
    throw new Error(gitCommandError(cwd, { ...gitDir, status: gitDir.code }, 'git dir'))
  const dir = gitDir.stdout.trim()
  const presentMarkers = GATE_CHECKOUT_OPERATION_MARKERS.filter((marker) =>
    existsSync(join(dir, marker)),
  )
  const unmerged = gitAt(cwd, nulPathListArgs(['ls-files', '-u']))
  if (unmerged.code !== 0)
    throw new Error(gitCommandError(cwd, { ...unmerged, status: unmerged.code }, 'git ls-files'))
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
