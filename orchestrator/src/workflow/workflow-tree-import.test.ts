import { expect, test } from 'bun:test'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { parseWorkflowTree, planWorkflowHydration } from './workflow-tree.ts'
import { importWorkflowTree, productionWorkflowTree } from './workflow-tree-store.ts'

const database = testDatabaseFixture((d) => seedWorkflows(d))

test('an unknown step key refuses the whole import before any draft is written', () => {
  const d = database()
  const tree = planWorkflowHydration({
    store: productionWorkflowTree({ database: d }),
    tree: [],
  }).writes
  const target = tree.find(({ path }) => path === '.agents/workflow-steps/blast-radius.md')!
  target.body = target.body.replace('\n---\n', '\nfutureSetting: enabled\n---\n')

  expect(() =>
    importWorkflowTree(parseWorkflowTree(tree), 'unknown step setting', 'worker', d),
  ).toThrow(
    '.agents/workflow-steps/blast-radius.md: unknown workflow step frontmatter key "futureSetting"; ' +
      'a new step setting lands in two pull requests: first the parser support for futureSetting, ' +
      'then the step files once that is on main.',
  )
  expect(
    d.query("SELECT count(*) AS count FROM step_catalogue_version WHERE status='draft'").get(),
  ).toEqual({ count: 0 })
  expect(
    d.query("SELECT count(*) AS count FROM workflow_version WHERE status='draft'").get(),
  ).toEqual({ count: 0 })
})
