import { expect, test } from 'bun:test'
import {
  workflowCommandPresentation as presentation,
  runWorkflowCommand as workflowCommand,
} from './workflow-store.fixture.ts'

test('workflow catalogue fork refusal names how to clear an unowned directory', async () => {
  await expect(
    workflowCommand(['workflow', 'catalogue', 'fork', '--from', '1'], presentation([]), {
      cwd: '/private/tmp/unowned-workflow-catalogue',
    }),
  ).rejects.toThrow(
    'cannot fork the workflow step catalogue: no registered project contains /private/tmp/unowned-workflow-catalogue\n' +
      "cleared by: run from a registered project's worktree, or pass --cwd for one",
  )
})
