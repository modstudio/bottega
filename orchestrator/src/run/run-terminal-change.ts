// concern: run-terminal-change
/** Measures whether one writing turn changed either the checkout tip or visible content. */
import type { Database } from 'bun:sqlite'
import { contentTree, gitContext } from '../git/git-environment.ts'

type MeasurementScope = { measure<T>(operation: () => T): T }

function compareTurnState(database: Database, runId: number, worktreePath: string): boolean | null {
  const started = database
    .query('SELECT head_commit, input_tree FROM run WHERE id=?')
    .get(runId) as { head_commit: string | null; input_tree: string | null } | null
  if (!started?.head_commit || !started.input_tree) return null
  const terminalHead = gitContext(worktreePath, 'rev-parse', '--verify', 'HEAD^{commit}')
  const terminalTree = contentTree(worktreePath)
  return terminalHead !== started.head_commit || terminalTree !== started.input_tree
}

export function terminalTurnChanged(input: {
  database: Database
  runId: number
  writingJob: boolean
  worktreePath: string | null
  measurementScope: MeasurementScope | null
  reportError?: (message: string) => void
}): boolean | null {
  if (!input.writingJob || !input.worktreePath) return null
  const worktreePath = input.worktreePath
  const measure = () => compareTurnState(input.database, input.runId, worktreePath)
  try {
    return input.measurementScope ? input.measurementScope.measure(measure) : measure()
  } catch (error) {
    const reportError = input.reportError ?? console.error
    reportError(`orch: could not measure the turn-local change for run ${input.runId}: ${error}`)
    return null
  }
}
