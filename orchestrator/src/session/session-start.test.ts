import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { promoteStepCatalogueLocal, setStepCatalogueLocal } from '../workflow/step-catalogue.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
import { parseWorkflowTree } from '../workflow/workflow-tree.ts'
import { collectWorkflowTree } from '../workflow/workflow-tree-files.ts'
import { promoteWorkflowLocal, setWorkflowLocal } from '../workflow/workflows.ts'
import { startSession } from './session-start.ts'

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

test('two starts for one session reuse one keyless explore cursor', async () => {
  const project = `session-start-${newRecordId()}`
  const session = newRecordId()
  upsertProject({
    recordId: newRecordId(),
    name: project,
    path: repositoryRoot,
    stack: 'bun',
    settings: { trunk: 'main', docs: { protocol: 'orch-docs' } },
  })
  const tree = parseWorkflowTree(collectWorkflowTree(repositoryRoot))
  const catalogue = setStepCatalogueLocal(
    { steps: tree.steps, sequences: tree.sequences },
    'session start fixture',
    'test',
  )
  promoteStepCatalogueLocal(catalogue.n, 'session start fixture', 'test')
  const explore = tree.workflows.find((workflow) => workflow.slug === 'explore')!
  const workflow = setWorkflowLocal(
    explore.slug,
    explore.definition,
    'session start fixture',
    'test',
  )
  promoteWorkflowLocal(explore.slug, workflow.n, 'session start fixture', 'test')

  const first = await startSession({ database: db(), cwd: repositoryRoot, session })
  const second = await startSession({ database: db(), cwd: repositoryRoot, session })
  const cursors = await taskFlowReadStore(db()).listOpenStages({ sessionId: session })

  expect(second.cursor).toBe(first.cursor)
  expect(cursors).toHaveLength(1)
  expect(cursors[0]).toMatchObject({
    id: first.cursor,
    workflow_slug: 'explore',
    workflow_key: '',
    session_id: session,
  })
})
