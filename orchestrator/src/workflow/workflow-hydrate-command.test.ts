import { expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  hostedWorkflowRepositoryFixture,
  installHostedWorkflowTreeFixture as installHostedWorkflowTree,
  workflowCommandOutcomePresentation as outcomePresentation,
  registerOwningWorkflowProject as registerOwningProject,
  runWorkflowCommand as workflowCommand,
} from './workflow-store.fixture.ts'

test('workflow hydrate protects an unimported edit until --discard names its path', async () => {
  const fixture = hostedWorkflowRepositoryFixture('hydrate-protection')
  const project = 'hydrate-protection-worktree'
  const path = '.agents/workflows/hosted.md'
  const target = resolve(fixture.worktree, path)
  registerOwningProject(project, fixture.mainCheckout)
  installHostedWorkflowTree(project, newRecordId(), fixture.worktree)
  const productionBody = readFileSync(target, 'utf8')
  const editedBody = productionBody.replace('Hosted fixture.', 'Unimported branch edit.')
  writeFileSync(target, editedBody)
  const protectedResult = outcomePresentation()
  try {
    await workflowCommand(
      ['workflow', 'hydrate', '--cwd', fixture.worktree],
      protectedResult.presentation,
    )
    expect(readFileSync(target, 'utf8')).toBe(editedBody)
    expect(protectedResult.stdout).toEqual([
      `protect ${path}: matches no production version`,
      `  keep: ${PLATFORM_SLUG} workflow import --cwd <tree> --reason "<why>"`,
      `  discard: ${PLATFORM_SLUG} workflow hydrate --cwd <tree> --discard ${path}`,
      'hydrated 0 paths',
    ])
    expect(protectedResult.exitCodes).toEqual([1])

    const discardResult = outcomePresentation()
    await workflowCommand(
      ['workflow', 'hydrate', '--cwd', fixture.worktree, '--discard', path],
      discardResult.presentation,
    )
    expect(readFileSync(target, 'utf8')).toBe(productionBody)
    expect(discardResult.stdout).toEqual([`write ${path}`, 'hydrated 1 paths'])
    expect(discardResult.exitCodes).toEqual([])
  } finally {
    fixture.dispose()
  }
})
