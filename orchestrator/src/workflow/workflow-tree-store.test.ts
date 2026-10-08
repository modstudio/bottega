import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { applyMigrations } from '../database/migrations.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogue,
  showStepCatalogue,
} from './step-catalogue.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { parseWorkflowTree, planWorkflowHydration } from './workflow-tree.ts'
import { collectWorkflowTree } from './workflow-tree-files.ts'
import { importWorkflowTree, productionWorkflowTree } from './workflow-tree-store.ts'
import {
  composeWorkflow,
  getWorkflowStep,
  productionWorkflows,
  promoteWorkflow,
  showWorkflow,
} from './workflows.ts'

const database = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  seedWorkflows(d)
  return d
}

const renderedTree = (d: Database) =>
  planWorkflowHydration({ store: productionWorkflowTree(d), tree: [] }).writes

const importAndPromoteCurrentTree = (d: Database) => {
  const root = fileURLToPath(new URL('../../..', import.meta.url))
  const imported = importWorkflowTree(
    parseWorkflowTree(collectWorkflowTree(root)),
    'compose current tree fixture',
    'test',
    d,
  )
  if (imported.steps.length || imported.sequences.length) {
    const catalogue = d
      .query("SELECT n FROM step_catalogue_version WHERE status='draft' ORDER BY n DESC LIMIT 1")
      .get() as { n: number }
    promoteStepCatalogue(catalogue.n, 'compose current tree fixture', 'test', d)
  }
  for (const slug of imported.workflows) {
    const workflow = d
      .query(
        "SELECT v.n FROM workflow_version v JOIN workflow w ON w.id=v.workflow_id WHERE w.slug=? AND v.status='draft'",
      )
      .get(slug) as { n: number }
    promoteWorkflow(slug, workflow.n, 'compose current tree fixture', 'test', d)
  }
}

describe('importWorkflowTree', () => {
  test('the current workflow tree round-trips through import and hydrate', () => {
    const d = database()
    const root = fileURLToPath(new URL('../../..', import.meta.url))
    const tree = collectWorkflowTree(root)

    const imported = importWorkflowTree(parseWorkflowTree(tree), 'validate current tree', 'test', d)
    const draft = d
      .query("SELECT n FROM step_catalogue_version WHERE status='draft' ORDER BY n DESC LIMIT 1")
      .get() as { n: number } | null
    if (draft) promoteStepCatalogue(draft.n, 'round-trip fixture', 'test', d)
    for (const slug of imported.workflows) {
      const workflowDraft = d
        .query(
          "SELECT v.n FROM workflow_version v JOIN workflow w ON w.id=v.workflow_id WHERE w.slug=? AND v.status='draft'",
        )
        .get(slug) as { n: number }
      promoteWorkflow(slug, workflowDraft.n, 'round-trip fixture', 'test', d)
    }
    expect(planWorkflowHydration({ store: productionWorkflowTree(d), tree })).toEqual({
      writes: [],
      deletes: [],
    })
  })

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

  test('a sequence file imports into the catalogue draft', () => {
    const d = database()
    const tree = renderedTree(d)
    tree.push({
      path: '.agents/workflow-sequences/quality.md',
      body: '---\nslug: quality\ntitle: Quality\nsteps:\n  - lens\n  - score\n---\n\n',
    })

    const result = importWorkflowTree(parseWorkflowTree(tree), 'add sequence', 'worker', d)

    expect(result).toEqual({ steps: [], sequences: ['quality'], workflows: [] })
    const draft = d
      .query("SELECT n FROM step_catalogue_version WHERE status='draft' ORDER BY n DESC LIMIT 1")
      .get() as { n: number }
    expect(showStepCatalogue(draft.n, d).definition.sequences).toEqual([
      { slug: 'quality', title: 'Quality', steps: ['lens', 'score'] },
    ])
  })

  test('sync docs composes through orch-docs and array-mcp', () => {
    const d = database()
    const root = fileURLToPath(new URL('../../..', import.meta.url))
    const imported = importWorkflowTree(
      parseWorkflowTree(collectWorkflowTree(root)),
      'compose sync docs fixture',
      'test',
      d,
    )
    const catalogue = d
      .query("SELECT n FROM step_catalogue_version WHERE status='draft' ORDER BY n DESC LIMIT 1")
      .get() as { n: number }
    promoteStepCatalogue(catalogue.n, 'compose fixture', 'test', d)
    const ship = d
      .query(
        "SELECT v.n FROM workflow_version v JOIN workflow w ON w.id=v.workflow_id WHERE w.slug='ship' AND v.status='draft'",
      )
      .get() as { n: number }
    expect(imported.workflows).toContain('ship')
    promoteWorkflow('ship', ship.n, 'compose fixture', 'test', d)

    for (const [project, protocol] of [
      ['orch-docs-fixture', 'orch-docs'],
      ['array-fixture', 'array-mcp'],
    ] as const) {
      d.query('INSERT INTO project (name,path,stack,settings) VALUES (?,?,?,?)').run(
        project,
        `/${project}`,
        'bun',
        JSON.stringify({ docs: { protocol } }),
      )
      const step = getWorkflowStep(
        'ship',
        project,
        'sync-docs',
        { key: 'DEV-945', branch: 'DEV-945-fixture', worktree: '/fixture' },
        d,
      )
      expect(step.needs).toEqual(['docs'])
      expect(step.body).toContain(`adapter is named by \`${protocol}\``)
      if (protocol === 'array-mcp') {
        expect(step.body).toContain(
          'call its read and write actions on the server named in `facts`',
        )
      } else {
        expect(step.body).toContain(
          '`orch doc set` with `--scope project --subject orch-docs-fixture`',
        )
      }
      expect(step.body).not.toContain('{{')
    }
  })

  test('a single review state resolves both new steps in ship-task and code-review', () => {
    const d = database()
    importAndPromoteCurrentTree(d)
    d.query('INSERT INTO project (name,path,stack,settings) VALUES (?,?,?,?)').run(
      'fixture',
      '/fixture',
      'bun',
      JSON.stringify({
        tracker: {
          protocol: 'workspace-mcp',
          states: { started: 'active', checking: 'review', completed: 'done' },
        },
        docs: { protocol: 'orch-docs' },
        gate: 'bun run check',
        trunk: 'main',
        release: { rungs: [], mergeMethod: 'squash', requiredChecks: [] },
      }),
    )
    const args = { key: 'DEV-1178', branch: 'DEV-1178-test', worktree: '/fixture' }
    const ship = composeWorkflow('ship-task', 'fixture', 'merge', args, d)
    const review = composeWorkflow('code-review', 'fixture', 'report', args, d)
    const waiting = ship.steps.find(({ slug }) => slug === 'waiting-for-review')!
    const inReview = review.steps[0]!

    expect(waiting).toMatchObject({
      floor: ['tracker-transition'],
      expectedStatus: ['checking', 'checking'],
    })
    expect(inReview).toMatchObject({
      slug: 'in-review',
      floor: ['tracker-transition'],
      expectedStatus: 'checking',
    })
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
    ).toThrow('invalid floor kind "not-a-proof"')
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

    expect(result).toEqual({ steps: ['tree-step'], sequences: [], workflows: ['tree-flow'] })
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
