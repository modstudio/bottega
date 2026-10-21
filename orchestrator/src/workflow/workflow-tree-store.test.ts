import type { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogueLocal,
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
  promoteWorkflowLocal,
  showWorkflow,
} from './workflows.ts'

const database = testDatabaseFixture((d) => {
  seedWorkflows(d)
})

const renderedTree = (d: Database) =>
  planWorkflowHydration({ store: productionWorkflowTree(d), tree: [] }).writes

const importAndPromoteCurrentTree = async (d: Database) => {
  const root = fileURLToPath(new URL('../../..', import.meta.url))
  const imported = await importWorkflowTree(
    parseWorkflowTree(collectWorkflowTree(root)),
    'compose current tree fixture',
    'test',
    d,
  )
  if (imported.steps.length || imported.sequences.length) {
    const catalogue = d
      .query("SELECT n FROM step_catalogue_version WHERE status='draft' ORDER BY n DESC LIMIT 1")
      .get() as { n: number }
    promoteStepCatalogueLocal(catalogue.n, 'compose current tree fixture', 'test', d)
  }
  for (const slug of imported.workflows) {
    const workflow = d
      .query(
        "SELECT v.n FROM workflow_version v JOIN workflow w ON w.id=v.workflow_id WHERE w.slug=? AND v.status='draft'",
      )
      .get(slug) as { n: number }
    promoteWorkflowLocal(slug, workflow.n, 'compose current tree fixture', 'test', d)
  }
}

describe('importWorkflowTree', () => {
  test('the current workflow tree round-trips through import and hydrate', async () => {
    const d = database()
    const root = fileURLToPath(new URL('../../..', import.meta.url))
    const tree = collectWorkflowTree(root)

    const imported = await importWorkflowTree(
      parseWorkflowTree(tree),
      'validate current tree',
      'test',
      d,
    )
    const draft = d
      .query("SELECT n FROM step_catalogue_version WHERE status='draft' ORDER BY n DESC LIMIT 1")
      .get() as { n: number } | null
    if (draft) promoteStepCatalogueLocal(draft.n, 'round-trip fixture', 'test', d)
    for (const slug of imported.workflows) {
      const workflowDraft = d
        .query(
          "SELECT v.n FROM workflow_version v JOIN workflow w ON w.id=v.workflow_id WHERE w.slug=? AND v.status='draft'",
        )
        .get(slug) as { n: number }
      promoteWorkflowLocal(slug, workflowDraft.n, 'round-trip fixture', 'test', d)
    }
    expect(planWorkflowHydration({ store: productionWorkflowTree(d), tree })).toEqual({
      writes: [],
      deletes: [],
    })
  })

  test('an edited step becomes a catalogue draft while production remains unchanged', async () => {
    const d = database()
    const production = productionStepCatalogue(d)
    const tree = renderedTree(d)
    const target = tree.find(({ path }) => path === '.agents/workflow-steps/blast-radius.md')!
    target.body = target.body.replace(/\n---\n[\s\S]*\n$/, '\n---\nAn edited lens body.\n')

    const result = await importWorkflowTree(parseWorkflowTree(tree), 'edit lens', 'worker', d)

    expect(result.steps).toEqual(['blast-radius'])
    const draft = d
      .query("SELECT n FROM step_catalogue_version WHERE status='draft' ORDER BY n DESC LIMIT 1")
      .get() as { n: number }
    expect(
      showStepCatalogue(draft.n, d).definition.steps.find((step) => step.slug === 'blast-radius')
        ?.body,
    ).toBe('An edited lens body.')
    expect(productionStepCatalogue(d).n).toBe(production.n)
    expect(
      productionStepCatalogue(d).definition.steps.find((step) => step.slug === 'blast-radius')
        ?.body,
    ).toBe(production.definition.steps.find((step) => step.slug === 'blast-radius')?.body)
  })

  test('a sequence file imports into the catalogue draft', async () => {
    const d = database()
    const tree = renderedTree(d)
    tree.push({
      path: '.agents/workflow-sequences/quality.md',
      body: '---\nslug: quality\ntitle: Quality\nsteps:\n  - diagnose\n  - verify\n---\n\n',
    })

    const result = await importWorkflowTree(parseWorkflowTree(tree), 'add sequence', 'worker', d)

    expect(result).toMatchObject({
      steps: [],
      sequences: ['quality'],
      workflows: [],
      catalogue: { status: 'created' },
    })
    const draft = d
      .query("SELECT n FROM step_catalogue_version WHERE status='draft' ORDER BY n DESC LIMIT 1")
      .get() as { n: number }
    expect(showStepCatalogue(draft.n, d).definition.sequences).toEqual([
      { slug: 'quality', title: 'Quality', steps: ['diagnose', 'verify'] },
    ])
  })

  test('the documentation apply step composes through orch-docs and array-mcp', async () => {
    const d = database()
    const root = fileURLToPath(new URL('../../..', import.meta.url))
    const imported = await importWorkflowTree(
      parseWorkflowTree(collectWorkflowTree(root)),
      'compose sync docs fixture',
      'test',
      d,
    )
    const catalogue = d
      .query("SELECT n FROM step_catalogue_version WHERE status='draft' ORDER BY n DESC LIMIT 1")
      .get() as { n: number }
    promoteStepCatalogueLocal(catalogue.n, 'compose fixture', 'test', d)
    const shipTask = d
      .query(
        "SELECT v.n FROM workflow_version v JOIN workflow w ON w.id=v.workflow_id WHERE w.slug='ship-task' AND v.status='draft'",
      )
      .get() as { n: number }
    expect(imported.workflows).toContain('ship-task')
    promoteWorkflowLocal('ship-task', shipTask.n, 'compose fixture', 'test', d)

    for (const [project, protocol] of [
      ['orch-docs-fixture', 'orch-docs'],
      ['array-fixture', 'array-mcp'],
    ] as const) {
      d.query(
        'INSERT INTO project (record_id,name,path,stack,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?,?)',
      ).run(
        project,
        `/${project}`,
        'bun',
        JSON.stringify({ tracker: { protocol: 'hub' }, docs: { protocol } }),
      )
      const step = getWorkflowStep(
        'ship-task',
        project,
        'docs-apply',
        { key: 'DEV-945', branch: 'DEV-945-fixture', worktree: '/fixture' },
        d,
      )
      expect(step.needs).toEqual(['tracker', 'docs'])
      expect(step.body).toContain(`adapter is named by \`${protocol}\``)
      if (protocol === 'array-mcp') {
        expect(step.body).toContain(
          'call its read and write actions on the server named in `facts`',
        )
      } else {
        expect(step.body).toContain(
          `\`${PLATFORM_SLUG} doc set\` with \`--scope project --subject orch-docs-fixture\``,
        )
      }
      expect(step.body).not.toContain('{{')
    }
  })

  test('a single review state resolves both new steps in ship-task and code-review', async () => {
    const d = database()
    await importAndPromoteCurrentTree(d)
    d.query(
      'INSERT INTO project (record_id,name,path,stack,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?,?)',
    ).run(
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

  test('intake carries declared signals and leaves workflows without that need unaffected', async () => {
    const d = database()
    await importAndPromoteCurrentTree(d)
    d.query(
      'INSERT INTO project (record_id,name,path,stack,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?,?)',
    ).run(
      'fixture',
      '/fixture',
      'bun',
      JSON.stringify({ tracker: { protocol: 'hub' }, docs: { protocol: 'orch-docs' } }),
    )

    expect(() => composeWorkflow('intake', 'fixture', undefined, {}, d)).toThrow(
      `signals; set with: ${PLATFORM_SLUG} project set fixture --settings '{"signals":{"sources":[{"name":"<label>","list":"<command-or-tool>"}]}}'`,
    )
    expect(composeWorkflow('plan-task', 'fixture', 'feature', {}, d).workflow.slug).toBe(
      'plan-task',
    )

    const signals = {
      sources: [{ name: 'errors', list: 'error_list', get: 'error_get' }],
    }
    d.query('UPDATE project SET settings=? WHERE name=?').run(
      JSON.stringify({
        tracker: { protocol: 'hub' },
        docs: { protocol: 'orch-docs' },
        signals,
      }),
      'fixture',
    )
    const composed = composeWorkflow('intake', 'fixture', undefined, {}, d)
    expect(composed.facts.signals).toEqual(signals)
  })

  test('one invalid floor refuses the entire import without writing a draft', () => {
    const d = database()
    const tree = renderedTree(d)
    const lens = tree.find(({ path }) => path === '.agents/workflow-steps/blast-radius.md')!
    lens.body = lens.body.replace('\n---\n', '\n---\nEdited but valid.\n')
    const score = tree.find(({ path }) => path === '.agents/workflow-steps/verify.md')!
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

  test('a new flow may reference a new step from the same tree import', async () => {
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

    const result = await importWorkflowTree(parseWorkflowTree(tree), 'add tree flow', 'worker', d)

    expect(result).toMatchObject({
      steps: ['tree-step'],
      sequences: [],
      workflows: ['tree-flow'],
      catalogue: { status: 'created' },
    })
    expect(result.workflowOutcomes).toContainEqual({
      slug: 'tree-flow',
      status: 'created',
      n: 1,
    })
    const draft = d
      .query("SELECT n FROM step_catalogue_version WHERE status='draft' ORDER BY n DESC LIMIT 1")
      .get() as { n: number }
    expect(
      showStepCatalogue(draft.n, d).definition.steps.some(({ slug }) => slug === 'tree-step'),
    ).toBe(true)
    expect(showWorkflow('tree-flow', undefined, d).status).toBe('draft')
    expect(productionStepCatalogue(d).n).toBe(productionCatalogue.n)
    expect(productionWorkflows(d)).toEqual(productionFlows)
    expect(() =>
      promoteWorkflowLocal('tree-flow', 1, 'must await catalogue promotion', 'test', d),
    ).toThrow('references missing step "tree-step"')
  })

  test('a production flow missing from the tree refuses the import and writes nothing', () => {
    const d = database()
    const tree = renderedTree(d).filter(({ path }) => path !== '.agents/workflows/fix-defect.md')
    const before = {
      catalogues: (
        d.query('SELECT COUNT(*) count FROM step_catalogue_version').get() as {
          count: number
        }
      ).count,
      workflows: (d.query('SELECT COUNT(*) count FROM workflow_version').get() as { count: number })
        .count,
    }

    expect(() => importWorkflowTree(parseWorkflowTree(tree), 'drop fixture', 'worker', d)).toThrow(
      `${PLATFORM_SLUG} workflow retire fix-defect`,
    )
    expect(
      (d.query('SELECT COUNT(*) count FROM step_catalogue_version').get() as { count: number })
        .count,
    ).toBe(before.catalogues)
    expect(
      (d.query('SELECT COUNT(*) count FROM workflow_version').get() as { count: number }).count,
    ).toBe(before.workflows)
  })

  test('an import equal to the newest drafts reports no change and writes nothing', async () => {
    const d = database()
    const tree = renderedTree(d)
    const target = tree.find(({ path }) => path === '.agents/workflow-steps/blast-radius.md')!
    target.body = target.body.replace(/\n---\n[\s\S]*\n$/, '\n---\nA stable draft body.\n')
    const flow = tree.find(({ path }) => path === '.agents/workflows/fix-defect.md')!
    flow.body = flow.body.replace(/\n---\n[\s\S]*\n$/, '\n---\nA stable workflow draft.\n')

    const first = await importWorkflowTree(parseWorkflowTree(tree), 'first import', 'worker', d)
    const before = {
      catalogue: (
        d.query('SELECT COUNT(*) count FROM step_catalogue_version').get() as { count: number }
      ).count,
      workflows: (d.query('SELECT COUNT(*) count FROM workflow_version').get() as { count: number })
        .count,
    }
    const second = await importWorkflowTree(parseWorkflowTree(tree), 'retry import', 'worker', d)

    expect(first.catalogue.status).toBe('created')
    expect(first.workflowOutcomes).toContainEqual({ slug: 'fix-defect', status: 'created', n: 2 })
    expect(second.catalogue).toEqual({ status: 'no change' })
    expect(second.workflowOutcomes).toContainEqual({ slug: 'fix-defect', status: 'no change' })
    expect(
      (d.query('SELECT COUNT(*) count FROM step_catalogue_version').get() as { count: number })
        .count,
    ).toBe(before.catalogue)
    expect(
      (d.query('SELECT COUNT(*) count FROM workflow_version').get() as { count: number }).count,
    ).toBe(before.workflows)
  })
})
