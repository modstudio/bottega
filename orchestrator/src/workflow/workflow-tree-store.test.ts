import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import { productionStepCatalogue, showStepCatalogue } from './step-catalogue.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { parseWorkflowTree, planWorkflowHydration } from './workflow-tree.ts'
import { importWorkflowTree, productionWorkflowTree } from './workflow-tree-store.ts'
import { productionWorkflows, showWorkflow } from './workflows.ts'

const database = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  seedWorkflows(d)
  return d
}

const renderedTree = (d: Database) =>
  planWorkflowHydration({ store: productionWorkflowTree(d), tree: [] }).writes

describe('importWorkflowTree', () => {
  test('an edited step becomes a catalogue draft while production remains unchanged', () => {
    const d = database()
    const production = productionStepCatalogue(d)
    const tree = renderedTree(d)
    const target = tree.find(({ path }) => path === '.agents/workflow-steps/lens.md')!
    target.body = target.body.replace(/\n---\n[\s\S]*\n$/, '\n---\nAn edited lens body.\n')

    const result = importWorkflowTree(parseWorkflowTree(tree), 'edit lens', 'worker', d)

    expect(result.steps).toEqual(['lens'])
    const draft = d
      .query("SELECT n FROM step_catalogue_version WHERE status='draft' ORDER BY n DESC LIMIT 1")
      .get() as { n: number }
    expect(
      showStepCatalogue(draft.n, d).definition.steps.find((step) => step.slug === 'lens')?.body,
    ).toBe('An edited lens body.')
    expect(productionStepCatalogue(d).n).toBe(production.n)
    expect(
      productionStepCatalogue(d).definition.steps.find((step) => step.slug === 'lens')?.body,
    ).toBe(production.definition.steps.find((step) => step.slug === 'lens')?.body)
  })

  test('one invalid floor refuses the entire import without writing a draft', () => {
    const d = database()
    const tree = renderedTree(d)
    const lens = tree.find(({ path }) => path === '.agents/workflow-steps/lens.md')!
    lens.body = lens.body.replace('\n---\n', '\n---\nEdited but valid.\n')
    const score = tree.find(({ path }) => path === '.agents/workflow-steps/score.md')!
    const validScore = score.body
    score.body = score.body.replace(/floor:\n(?: {2}- [^\n]+\n)+/, 'floor:\n  - not-a-proof\n')
    expect(score.body).not.toBe(validScore)
    const before = d.query('SELECT COUNT(*) count FROM step_catalogue_version').get() as {
      count: number
    }

    expect(() =>
      importWorkflowTree(parseWorkflowTree(tree), 'invalid import', 'worker', d),
    ).toThrow('invalid proof kind "not-a-proof"')
    expect(
      (d.query('SELECT COUNT(*) count FROM step_catalogue_version').get() as { count: number })
        .count,
    ).toBe(before.count)
  })

  test('a new flow may reference a new step from the same tree import', () => {
    const d = database()
    const productionCatalogue = productionStepCatalogue(d)
    const productionFlows = productionWorkflows(d)
    const tree = renderedTree(d)
    tree.push({
      path: '.agents/workflow-steps/tree-step.md',
      body: `---\n${Bun.YAML.stringify({
        title: 'Tree step',
        stage: 'implement',
        floor: ['command-exit'],
        job: null,
        autonomy: 'auto',
        needs: [],
      })}\n---\nA step added in the tree.\n`,
    })
    tree.push({
      path: '.agents/workflows/tree-flow.md',
      body: `---\n${Bun.YAML.stringify({
        title: 'Tree flow',
        arguments: [],
        modes: [
          {
            slug: 'default',
            title: 'Default',
            default: true,
            steps: ['tree-step'],
          },
        ],
      })}\n---\nA flow added in the tree.\n`,
    })

    const result = importWorkflowTree(parseWorkflowTree(tree), 'add tree flow', 'worker', d)

    expect(result).toEqual({ steps: ['tree-step'], workflows: ['tree-flow'] })
    const draft = d
      .query("SELECT n FROM step_catalogue_version WHERE status='draft' ORDER BY n DESC LIMIT 1")
      .get() as { n: number }
    expect(
      showStepCatalogue(draft.n, d).definition.steps.some(({ slug }) => slug === 'tree-step'),
    ).toBe(true)
    expect(showWorkflow('tree-flow', undefined, d).status).toBe('draft')
    expect(productionStepCatalogue(d).n).toBe(productionCatalogue.n)
    expect(productionWorkflows(d)).toEqual(productionFlows)
  })

  test('a production flow missing from the tree refuses the import and writes nothing', () => {
    const d = database()
    const tree = renderedTree(d).filter(({ path }) => path !== '.agents/workflows/ship.md')
    const before = {
      catalogues: (
        d.query('SELECT COUNT(*) count FROM step_catalogue_version').get() as {
          count: number
        }
      ).count,
      workflows: (d.query('SELECT COUNT(*) count FROM workflow_version').get() as { count: number })
        .count,
    }

    expect(() => importWorkflowTree(parseWorkflowTree(tree), 'drop ship', 'worker', d)).toThrow(
      'orch workflow retire ship',
    )
    expect(
      (d.query('SELECT COUNT(*) count FROM step_catalogue_version').get() as { count: number })
        .count,
    ).toBe(before.catalogues)
    expect(
      (d.query('SELECT COUNT(*) count FROM workflow_version').get() as { count: number }).count,
    ).toBe(before.workflows)
  })
})
