import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, sep } from 'node:path'
import { resolveOrchestratorDatabase } from '../shared/state-directory.ts'

function beneath(directory: string, candidate: string): boolean {
  const offset = relative(directory, candidate)
  return offset !== '' && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)
}

test('the root preload supplies a temporary orchestrator store', () => {
  const scratchStore = process.env.BOTTEGA_ORCHESTRATOR_DB
  expect(scratchStore).toBeDefined()
  expect(beneath(tmpdir(), scratchStore!)).toBe(true)

  const { BOTTEGA_ORCHESTRATOR_DB: _scratch, ...liveEnvironment } = process.env
  expect(scratchStore).not.toBe(resolveOrchestratorDatabase(liveEnvironment))
})
