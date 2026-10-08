import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogue,
  setStepCatalogue,
} from './step-catalogue.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { installWorkflowStoreFixture } from './workflow-store.fixture.ts'
import {
  composeWorkflow,
  getWorkflowStep,
  importWorkflow,
  promoteWorkflow,
  setWorkflow,
  showWorkflow,
  validateWorkflowDefinition,
  type WorkflowDefinition,
  workflowVersions,
} from './workflows.ts'

const valid = (): WorkflowDefinition => ({
  title: 'A workflow',
  description: 'Does work.',
  arguments: [
    { name: 'key', required: true, description: 'Task key' },
    { name: 'branch', required: true, description: 'Branch' },
    { name: 'worktree', required: true, description: 'Worktree' },
  ],
  modes: [{ slug: 'default', title: 'Default', default: true, steps: ['lens'] }],
})
const release = {
  rungs: [{ name: 'production', branch: 'production', deploy: 'bun run deploy' }],
  mergeMethod: 'squash' as const,
  requiredChecks: ['gate'],
  observationWindowHours: 24,
}
const database = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  seedWorkflows(d)
  installWorkflowStoreFixture(d)
  d.query('INSERT INTO project (name,path,stack,settings) VALUES (?,?,?,?)').run(
    'fixture',
    '/fixture',
    'bun',
    JSON.stringify({
      gate: 'bun run check',
      trunk: 'develop',
      docs: { protocol: 'orch-docs' },
      tracker: { protocol: 'hub' },
    }),
  )
  return d
}
const promotePlanTask = (d: Database) => {
  const current = productionStepCatalogue(d).definition
  const catalogue = setStepCatalogue(
    {
      steps: [
        ...current.steps,
        {
          slug: 'injection-search',
          stage: 'plan',
          title: 'Search',
          body: 'Search with {{tracker.actions.search}}.',
          floor: ['ruling'],
          job: null,
          autonomy: 'ask',
          needs: ['tracker'],
        },
        {
          slug: 'injection-start',
          stage: 'plan',
          title: 'Start',
          body: 'Move to {{tracker.states.active}} with {{tracker.actions.status}} after {{tracker.actions.get}}.',
          floor: ['tracker-transition'],
          job: null,
          autonomy: 'auto',
          needs: ['tracker'],
        },
      ],
    },
    'workflow injection fixture',
    'test',
    d,
  )
  promoteStepCatalogue(catalogue.n, 'publish', 'test', d)
  const draft = setWorkflow(
    'plan-task',
    {
      title: 'Plan a task',
      description: 'Plan.',
      arguments: [{ name: 'key', required: false, description: 'Existing task key.' }],
      modes: [
        {
          slug: 'default',
          title: 'Plan',
          default: true,
          steps: ['injection-search', 'injection-start'],
        },
      ],
    },
    'workflow injection fixture',
    'test',
    d,
  )
  promoteWorkflow('plan-task', draft.n, 'publish', 'test', d)
}

describe('workflow definition validation', () => {
  test('accepts catalogue references and rejects inline or missing steps', () => {
    const d = database()
    expect(validateWorkflowDefinition(valid(), d)).toEqual([])
    expect(validateWorkflowDefinition({ ...valid(), steps: [] }, d)).toContain(
      'steps belongs in the shared step catalogue',
    )
    const missing = valid()
    missing.modes[0]!.steps = ['absent']
    expect(validateWorkflowDefinition(missing, d).join('\n')).toContain('references missing step')
  })
  test('refuses an invalid entry and a sequence expansion with a duplicate step', () => {
    const d = database()
    const current = productionStepCatalogue(d).definition
    const catalogue = setStepCatalogue(
      {
        steps: current.steps,
        sequences: [{ slug: 'quality', title: 'Quality', steps: ['lens', 'score'] }],
      },
      'sequence fixture',
      'test',
      d,
    )
    promoteStepCatalogue(catalogue.n, 'publish', 'test', d)
    expect(
      validateWorkflowDefinition(
        { ...valid(), modes: [{ ...valid().modes[0]!, steps: [{ step: 'lens' }] }] },
        d,
      ).join('\n'),
    ).toContain('must be a step slug or exactly')
    expect(
      validateWorkflowDefinition(
        {
          ...valid(),
          modes: [{ ...valid().modes[0]!, steps: ['lens', { sequence: 'quality' }] }],
        },
        d,
      ).join('\n'),
    ).toContain('expands to duplicate step "lens"')
  })
  test('validates modes and arguments', () => {
    const d = database(),
      definition = valid()
    definition.modes.push({ slug: 'other', title: 'Other', default: true, steps: ['lens'] })
    expect(validateWorkflowDefinition(definition, d)).toContain(
      'exactly one default mode is allowed',
    )
  })
  test('accepts boolean rebind and refuses malformed or key rebind declarations', () => {
    const d = database()
    expect(
      validateWorkflowDefinition(
        {
          ...valid(),
          arguments: [
            { name: 'key', required: true, description: 'Task key' },
            { name: 'worktree', required: true, description: 'Worktree path', rebind: true },
          ],
        },
        d,
      ),
    ).toEqual([])
    expect(
      validateWorkflowDefinition(
        {
          ...valid(),
          arguments: [
            { name: 'key', required: true, description: 'Task key' },
            { name: 'worktree', required: true, description: 'Worktree path', rebind: 'yes' },
          ],
        },
        d,
      ),
    ).toContain('argument "worktree" rebind must be a boolean')
    expect(
      validateWorkflowDefinition(
        {
          ...valid(),
          arguments: [{ name: 'key', required: true, description: 'Task key', rebind: true }],
        },
        d,
      ),
    ).toContain('argument "key" cannot declare rebind')
  })
  test('validates the workflow default preset', () => {
    const d = database()
    expect(validateWorkflowDefinition({ ...valid(), defaultPreset: 'autonomous' }, d)).toEqual([])
    expect(validateWorkflowDefinition({ ...valid(), defaultPreset: 'automatic' }, d)).toContain(
      'defaultPreset must be manual, guided, or autonomous',
    )
  })
  test('refuses malformed or undeclared mode requirements', () => {
    const d = database()
    expect(
      validateWorkflowDefinition(
        { ...valid(), modes: [{ ...valid().modes[0]!, requires: ['absent'] }] },
        d,
      ),
    ).toContain('mode "default" requires undeclared argument "absent"')
    expect(
      validateWorkflowDefinition(
        { ...valid(), modes: [{ ...valid().modes[0]!, requires: 'key' }] },
        d,
      ),
    ).toContain('mode "default" requires must be a string array')
  })
  test('reserves workflow prompt argument names', () => {
    const d = database(),
      definition = valid()
    definition.arguments.push(
      { name: 'mode', required: false, description: 'Mode.' },
      { name: 'project', required: false, description: 'Project.' },
      { name: 'autonomy', required: false, description: 'Autonomy.' },
    )
    expect(validateWorkflowDefinition(definition, d)).toEqual(
      expect.arrayContaining([
        'argument name "mode" is reserved for the workflow prompt',
        'argument name "project" is reserved for the workflow prompt',
        'argument name "autonomy" is reserved for the workflow prompt',
      ]),
    )
  })
})

describe('workflow versions and project composition', () => {
  test('separate ship-to and tracker needs do not require a tracker review state', () => {
    const d = database()
    const current = productionStepCatalogue(d).definition
    const catalogue = setStepCatalogue(
      {
        steps: [
          ...current.steps,
          {
            slug: 'only-ship-to',
            stage: 'ship',
            title: 'Only ship-to',
            body: 'Ship to {{shipTo.level}}.',
            floor: ['command-exit'],
            job: null,
            autonomy: 'auto',
            needs: ['ship-to'],
          },
          {
            slug: 'only-tracker',
            stage: 'ship',
            title: 'Only tracker',
            body: 'Use {{tracker.kind}}.',
            floor: ['tracker-transition'],
            job: null,
            autonomy: 'auto',
            needs: ['tracker'],
          },
        ],
      },
      'separate ship-to and tracker fixtures',
      'test',
      d,
    )
    promoteStepCatalogue(catalogue.n, 'publish', 'test', d)
    const workflow = setWorkflow(
      'separate-ship-to-tracker',
      {
        title: 'Separate ship-to and tracker',
        description: 'Keep step needs separate.',
        arguments: [],
        modes: [
          {
            slug: 'default',
            title: 'Default',
            default: true,
            steps: ['only-ship-to', 'only-tracker'],
          },
        ],
      },
      'separate ship-to and tracker fixtures',
      'test',
      d,
    )
    promoteWorkflow('separate-ship-to-tracker', workflow.n, 'publish', 'test', d)
    d.query('UPDATE project SET settings=? WHERE name=?').run(
      JSON.stringify({
        tracker: { protocol: 'workspace-mcp', states: { completed: 'done' } },
        release,
        docs: { protocol: 'orch-docs' },
      }),
      'fixture',
    )
    const autonomy = {
      steps: {
        'only-ship-to': { value: 'auto' as const, scope: 'test' },
        'only-tracker': { value: 'auto' as const, scope: 'test' },
      },
      rulings: { value: 'agent' as const, scope: 'test' },
      shipTo: { value: 'trunk' as const, scope: 'project' },
    }

    const composed = composeWorkflow(
      'separate-ship-to-tracker',
      'fixture',
      undefined,
      {},
      d,
      {},
      autonomy,
    )
    const shipStep = getWorkflowStep(
      'separate-ship-to-tracker',
      'fixture',
      'only-ship-to',
      {},
      d,
      {},
      autonomy,
    )
    const trackerStep = getWorkflowStep(
      'separate-ship-to-tracker',
      'fixture',
      'only-tracker',
      {},
      d,
      {},
      autonomy,
    )

    expect(composed.facts.shipTo).toEqual(shipStep.facts.shipTo)
    expect(composed.facts.shipTo).not.toHaveProperty('closeState')
    expect(composed.facts.tracker).toEqual(trackerStep.facts.tracker)
  })

  test('renders the registered name through the built-in project placeholder', () => {
    const d = database()
    const current = productionStepCatalogue(d).definition
    const catalogue = setStepCatalogue(
      {
        steps: current.steps.map((step) =>
          step.slug === 'lens' ? { ...step, body: 'Check {{project}}.' } : step,
        ),
      },
      'project placeholder fixture',
      'test',
      d,
    )
    promoteStepCatalogue(catalogue.n, 'publish', 'test', d)

    expect(
      getWorkflowStep(
        'fixture-workflow',
        'fixture',
        'lens',
        { key: 'DEV-1', branch: 'DEV-1-work', worktree: '/work' },
        d,
      ).body,
    ).toBe('Check fixture.')
  })

  test("a mode's requirements apply to compose and step only in that mode", () => {
    const d = database()
    const draft = setWorkflow(
      'mode-arguments',
      {
        title: 'Mode arguments',
        description: 'Exercises mode arguments.',
        arguments: [{ name: 'key', required: false, description: 'Task key.' }],
        modes: [
          {
            slug: 'required',
            title: 'Required',
            default: true,
            requires: ['key'],
            steps: ['complete'],
          },
          { slug: 'optional', title: 'Optional', steps: ['complete'] },
        ],
      },
      'mode argument fixture',
      'test',
      d,
    )
    promoteWorkflow('mode-arguments', draft.n, 'publish', 'test', d)

    expect(composeWorkflow('mode-arguments', 'fixture', 'required', {}, d).needs.arguments).toEqual(
      [{ name: 'key', description: 'Task key.' }],
    )
    expect(
      composeWorkflow('mode-arguments', 'fixture', 'required', { key: '   ' }, d).needs.arguments,
    ).toEqual([{ name: 'key', description: 'Task key.' }])
    expect(composeWorkflow('mode-arguments', 'fixture', 'optional', {}, d).needs.arguments).toBe(
      undefined,
    )
    expect(() =>
      getWorkflowStep('mode-arguments', 'fixture', 'complete', {}, d, { mode: 'required' }),
    ).toThrow('missing required arguments: key')
    expect(
      getWorkflowStep('mode-arguments', 'fixture', 'complete', {}, d, { mode: 'optional' }).slug,
    ).toBe('complete')
  })

  test('a mode-less step fetch applies requirements from every containing mode', () => {
    const d = database()
    const draft = setWorkflow(
      'mode-less-arguments',
      {
        title: 'Mode-less arguments',
        description: 'Exercises mode-less step arguments.',
        arguments: [{ name: 'key', required: false, description: 'Task key.' }],
        modes: [
          {
            slug: 'a',
            title: 'A',
            default: true,
            requires: ['key'],
            steps: ['complete'],
          },
          { slug: 'b', title: 'B', steps: ['complete'] },
          { slug: 'c', title: 'C', steps: ['score'] },
        ],
      },
      'mode-less argument fixture',
      'test',
      d,
    )
    promoteWorkflow('mode-less-arguments', draft.n, 'publish', 'test', d)

    expect(() => getWorkflowStep('mode-less-arguments', 'fixture', 'complete', {}, d)).toThrow(
      'missing required arguments: key',
    )
    expect(getWorkflowStep('mode-less-arguments', 'fixture', 'score', {}, d).slug).toBe('score')
  })

  test('compose uses a requested draft workflow version instead of production', () => {
    const d = database(),
      draft = setWorkflow(
        'fixture-workflow',
        {
          ...valid(),
          modes: [{ slug: 'cohort', title: 'Cohort', default: true, steps: ['lens'] }],
        },
        'draft mode fixture',
        'test',
        d,
      )

    const composed = composeWorkflow('fixture-workflow', 'fixture', 'cohort', {}, d, { version: draft.n })

    expect(composed.workflow.version).toBe(draft.n)
    expect(composed.mode?.slug).toBe('cohort')
    expect(
      getWorkflowStep(
        'fixture-workflow',
        'fixture',
        'lens',
        { key: 'DEV-794', branch: 'DEV-794-test', worktree: '/tmp/test' },
        d,
        { version: draft.n },
      ).version,
    ).toBe(draft.n)
  })
  test('compose without a workflow version still uses production', () => {
    const d = database(),
      production = showWorkflow('fixture-workflow', undefined, d),
      draft = setWorkflow('fixture-workflow', valid(), 'ignored draft fixture', 'test', d)

    const composed = composeWorkflow('fixture-workflow', 'fixture', undefined, {}, d)

    expect(draft.n).not.toBe(production.n)
    expect(composed.workflow.version).toBe(production.n)
  })
  test('step successor carries its one-based position and is null at the selected mode end', () => {
    const d = database(),
      args = { key: 'DEV-821', branch: 'DEV-821-test', worktree: '/tmp/test' }

    expect(getWorkflowStep('fixture-workflow', 'fixture', 'rebase', args, d, { mode: 'default' }).next).toEqual(
      {
        n: 2,
        slug: 'lens',
        title: 'Run independent review lenses',
      },
    )
    expect(
      getWorkflowStep('fixture-workflow', 'fixture', 'close', args, d, { mode: 'default' }).next,
    ).toBeNull()
  })
  test('compose uses a requested draft catalogue version instead of production', () => {
    const d = database(),
      current = productionStepCatalogue(d).definition,
      lens = current.steps.find((step) => step.slug === 'lens')!,
      catalogue = setStepCatalogue(
        { steps: [...current.steps, { ...lens, slug: 'draft-step', title: 'Draft step' }] },
        'draft catalogue fixture',
        'test',
        d,
      ),
      workflow = importWorkflow(
        'draft-flow',
        {
          ...valid(),
          modes: [{ slug: 'default', title: 'Default', default: true, steps: ['draft-step'] }],
        },
        'draft workflow fixture',
        'test',
        d,
        catalogue.definition,
      )

    const composed = composeWorkflow('draft-flow', 'fixture', undefined, {}, d, {
      version: workflow.n,
      catalogueVersion: catalogue.n,
    })

    expect(composed.catalogue.version).toBe(catalogue.n)
    expect(composed.steps.map((step) => step.slug)).toEqual(['draft-step'])
    expect(
      getWorkflowStep(
        'draft-flow',
        'fixture',
        'draft-step',
        { key: 'DEV-794', branch: 'DEV-794-test', worktree: '/tmp/test' },
        d,
        { version: workflow.n, catalogueVersion: catalogue.n },
      ).catalogueVersion,
    ).toBe(catalogue.n)
  })
  test('compose refuses a selected mode with a missing catalogue step instead of crashing', () => {
    const d = database()
    const row = d
      .query(
        `SELECT v.id,v.definition FROM workflow w JOIN workflow_version v ON v.workflow_id=w.id
         WHERE w.slug='fixture-workflow' AND v.status='production'`,
      )
      .get() as { id: number; definition: string }
    const definition = JSON.parse(row.definition) as WorkflowDefinition
    definition.modes[0]!.steps = ['missing-compose-step']
    d.query('UPDATE workflow_version SET definition=? WHERE id=?').run(
      JSON.stringify(definition),
      row.id,
    )

    expect(() => composeWorkflow('fixture-workflow', 'fixture', undefined, {}, d)).toThrow(
      'workflow "fixture-workflow" names steps absent from the production catalogue:\n' +
        '- mode "default": "missing-compose-step"\n' +
        'fix: promote a catalogue step with that slug, or set the workflow to a mode that does not use it',
    )
  })
  test('keeps immutable workflow history', () => {
    const d = database(),
      first = setWorkflow('test-flow', valid(), 'first', 'author', d)
    const changed = valid()
    changed.title = 'Changed'
    const second = setWorkflow('test-flow', changed, 'second', 'author', d)
    promoteWorkflow('test-flow', first.n, 'publish', 'architect', d)
    promoteWorkflow('test-flow', second.n, 'replace', 'architect', d)
    expect(showWorkflow('test-flow', first.n, d).status).toBe('retired')
    expect(workflowVersions('test-flow', d)).toHaveLength(2)
  })
  test('renders the project trunk and refuses a missing trunk with its remedy', () => {
    const d = database()
    d.query('UPDATE project SET settings=? WHERE name=?').run(
      JSON.stringify({ trunk: 'develop', docs: { protocol: 'orch-docs' } }),
      'fixture',
    )
    const current = productionStepCatalogue(d).definition
    const catalogue = setStepCatalogue(
      {
        steps: [
          ...current.steps,
          {
            slug: 'land',
            stage: 'ship',
            title: 'Land',
            body: 'Land on {{trunk}}.',
            floor: ['ruling'],
            job: null,
            autonomy: 'ask',
            needs: ['trunk'],
          },
        ],
      },
      'trunk fixture',
      'test',
      d,
    )
    promoteStepCatalogue(catalogue.n, 'publish', 'test', d)
    const workflow = setWorkflow(
      'land',
      {
        title: 'Land',
        description: 'Land.',
        arguments: [],
        modes: [{ slug: 'default', title: 'Default', default: true, steps: ['land'] }],
      },
      'trunk fixture',
      'test',
      d,
    )
    promoteWorkflow('land', workflow.n, 'publish', 'test', d)

    expect(getWorkflowStep('land', 'fixture', 'land', {}, d).body).toBe('Land on develop.')
    d.query('UPDATE project SET settings=? WHERE name=?').run(
      JSON.stringify({ docs: { protocol: 'orch-docs' } }),
      'fixture',
    )
    expect(() => getWorkflowStep('land', 'fixture', 'land', {}, d)).toThrow(
      `- trunk; set with: orch project set fixture --settings '{"trunk":"<branch>"}'`,
    )
  })
  test('returns only the resolved facts needed by composed steps', () => {
    const d = database()
    d.query('UPDATE project SET settings=? WHERE name=?').run(
      JSON.stringify({ release, docs: { protocol: 'orch-docs' } }),
      'fixture',
    )
    const current = productionStepCatalogue(d).definition
    const catalogue = setStepCatalogue(
      {
        steps: [
          ...current.steps,
          {
            slug: 'release-facts',
            stage: 'ship',
            title: 'Release facts',
            body: 'Read the release facts.',
            floor: ['ruling'],
            job: null,
            autonomy: 'ask',
            needs: ['release'],
          },
        ],
      },
      'release facts fixture',
      'test',
      d,
    )
    promoteStepCatalogue(catalogue.n, 'publish', 'test', d)
    const workflow = setWorkflow(
      'release-facts',
      {
        title: 'Release facts',
        description: 'Release.',
        arguments: [],
        modes: [
          {
            slug: 'default',
            title: 'Default',
            default: true,
            steps: ['release-facts'],
          },
        ],
      },
      'release facts fixture',
      'test',
      d,
    )
    promoteWorkflow('release-facts', workflow.n, 'publish', 'test', d)

    const facts = composeWorkflow('release-facts', 'fixture', undefined, {}, d).facts
    expect(facts.release!.rungs).toEqual(release.rungs)
    expect(facts).toEqual({ release })
  })
  test('composes dedupe with the workspace tracker search tool', () => {
    const d = database()
    d.query('UPDATE project SET settings=? WHERE name=?').run(
      JSON.stringify({
        docs: { protocol: 'orch-docs' },
        tracker: {
          kind: 'workspace',
          protocol: 'workspace-mcp',
          states: { completed: 'done' },
        },
      }),
      'fixture',
    )
    const current = productionStepCatalogue(d).definition
    const catalogue = setStepCatalogue(
      {
        steps: [
          ...current.steps,
          {
            slug: 'dedupe',
            stage: 'plan',
            title: 'Dedupe',
            body: 'Search with {{tracker.actions.search}}.',
            floor: ['ruling'],
            job: null,
            autonomy: 'ask',
            needs: ['tracker'],
          },
        ],
      },
      'dedupe fixture',
      'test',
      d,
    )
    promoteStepCatalogue(catalogue.n, 'publish', 'test', d)
    const workflow = setWorkflow(
      'plan-task',
      {
        title: 'Plan task',
        description: 'Plan.',
        arguments: [],
        modes: [{ slug: 'default', title: 'Default', default: true, steps: ['dedupe'] }],
      },
      'dedupe fixture',
      'test',
      d,
    )
    promoteWorkflow('plan-task', workflow.n, 'publish', 'test', d)

    expect(getWorkflowStep('plan-task', 'fixture', 'dedupe', {}, d).body).toBe(
      'Search with list-tasks-tool.',
    )
  })
  test('uses hub state defaults but refuses an absent remote state', () => {
    const d = database()
    promotePlanTask(d)
    d.query('UPDATE project SET settings=? WHERE name=?').run(
      JSON.stringify({
        tracker: { protocol: 'hub' },
        worktree: { branch: '{key}-orch-{id}' },
      }),
      'fixture',
    )
    expect(
      getWorkflowStep('plan-task', 'fixture', 'injection-start', { key: 'DEV-661' }, d).body,
    ).toContain('Move to active')

    d.query('UPDATE project SET settings=? WHERE name=?').run(
      JSON.stringify({
        tracker: { protocol: 'workspace-mcp', states: { completed: 'done' } },
        worktree: { branch: '{key}-orch-{id}' },
      }),
      'fixture',
    )
    expect(() =>
      getWorkflowStep('plan-task', 'fixture', 'injection-start', { key: 'DEV-661' }, d),
    ).toThrow('unresolved workflow placeholder "tracker.states.active"')
  })
  test('refuses hostile hub placeholder values and names them', () => {
    const d = database()
    promotePlanTask(d)
    d.query('UPDATE project SET settings=? WHERE name=?').run(
      JSON.stringify({
        docs: { protocol: 'orch-docs' },
        tracker: { protocol: 'hub' },
        worktree: { branch: '{key}-orch-{id}' },
      }),
      'fixture',
    )
    expect(() =>
      getWorkflowStep('plan-task', 'fixture', 'injection-start', { key: 'DEV-1; cat secrets' }, d),
    ).toThrow('task-key value "DEV-1; cat secrets" does not match task-key grammar')

    d.query('UPDATE project SET name=? WHERE name=?').run('fixture; touch owned', 'fixture')
    expect(() =>
      getWorkflowStep('plan-task', 'fixture; touch owned', 'injection-search', {}, d),
    ).toThrow('project value "fixture; touch owned" does not match project-name grammar')
  })
  test('refuses missing project facts and unresolved placeholders', () => {
    const d = database(),
      args = { key: 'x', branch: 'b', worktree: '/w' }
    d.query("UPDATE project SET settings='{}' WHERE name='fixture'").run()
    expect(() => composeWorkflow('fixture-workflow', 'fixture', undefined, args, d)).toThrow('gate')
    d.query('UPDATE project SET settings=? WHERE name=?').run(
      JSON.stringify({ gate: 'ok', docs: { protocol: 'orch-docs' } }),
      'fixture',
    )
    const current = productionStepCatalogue(d).definition
    const draft = setStepCatalogue(
      {
        steps: current.steps.map((step) =>
          step.slug === 'lens' ? { ...step, body: '{{unknown}}' } : step,
        ),
      },
      'placeholder fixture',
      'a',
      d,
    )
    expect(() => promoteStepCatalogue(draft.n, 'publish', 'a', d)).toThrow(
      'workflow fixture-workflow, mode default, step lens, field body, placeholder unknown',
    )
  })
  test('an unresolved declared argument placeholder names the late-argument remedy', () => {
    const d = database(),
      current = productionStepCatalogue(d).definition
    const catalogue = setStepCatalogue(
      {
        steps: [
          ...current.steps,
          {
            slug: 'late-argument',
            stage: 'plan',
            title: 'Late argument',
            body: 'Use {{branch}}.',
            floor: ['recorded-artifact'],
            job: null,
            autonomy: 'auto',
            needs: [],
          },
        ],
      },
      'late argument fixture',
      'test',
      d,
    )
    promoteStepCatalogue(catalogue.n, 'publish', 'test', d)
    const workflow = setWorkflow(
      'late-argument',
      {
        title: 'Late argument',
        description: 'Use an argument later.',
        arguments: [{ name: 'branch', required: false, description: 'Branch.' }],
        modes: [{ slug: 'default', title: 'Default', default: true, steps: ['late-argument'] }],
      },
      'late argument fixture',
      'test',
      d,
    )
    promoteWorkflow('late-argument', workflow.n, 'publish', 'test', d)

    expect(() =>
      getWorkflowStep('late-argument', 'fixture', 'late-argument', {}, d, { mode: 'default' }),
    ).toThrow(
      'unresolved workflow placeholder "branch"; pass --arg branch=<value> on this step or next call',
    )
  })
  test('catalogue promotion refuses dropping a production workflow step', () => {
    const d = database(),
      current = productionStepCatalogue(d).definition
    const draft = setStepCatalogue(
      { steps: current.steps.filter((step) => step.slug !== 'lens') },
      'drop lens',
      'a',
      d,
    )
    expect(() => promoteStepCatalogue(draft.n, 'publish', 'a', d)).toThrow(
      'fixture-workflow: lens',
    )
  })
  test('workflow promotion refuses a draft whose step the catalogue has since dropped', () => {
    const d = database(),
      current = productionStepCatalogue(d).definition,
      lens = current.steps.find((step) => step.slug === 'lens')!
    const withTemp = setStepCatalogue(
      { steps: [...current.steps, { ...lens, slug: 'temp' }] },
      'add temp',
      'a',
      d,
    )
    promoteStepCatalogue(withTemp.n, 'publish', 'a', d)
    const definition = valid()
    definition.modes[0]!.steps = ['temp']
    const draft = setWorkflow('stale-flow', definition, 'uses temp', 'a', d)
    const withoutTemp = setStepCatalogue({ steps: current.steps }, 'drop temp', 'a', d)
    promoteStepCatalogue(withoutTemp.n, 'publish', 'a', d)
    expect(() => promoteWorkflow('stale-flow', draft.n, 'publish', 'a', d)).toThrow(
      'invalid workflow definition:\n- mode "default" references missing step "temp"',
    )
  })
  test('promotion guards preserve production sequence references', () => {
    const d = database()
    const current = productionStepCatalogue(d).definition
    const withSequence = setStepCatalogue(
      {
        steps: current.steps,
        sequences: [{ slug: 'quality', title: 'Quality', steps: ['lens', 'score'] }],
      },
      'add sequence',
      'test',
      d,
    )
    promoteStepCatalogue(withSequence.n, 'publish', 'test', d)
    const definition = {
      ...valid(),
      modes: [{ ...valid().modes[0]!, steps: [{ sequence: 'quality' }] }],
    }
    const flow = setWorkflow('sequence-guard', definition, 'use sequence', 'test', d)
    promoteWorkflow('sequence-guard', flow.n, 'publish', 'test', d)
    const withoutSequence = setStepCatalogue({ steps: current.steps }, 'drop sequence', 'test', d)
    expect(() => promoteStepCatalogue(withoutSequence.n, 'publish', 'test', d)).toThrow(
      'sequence "quality" is absent from the catalogue',
    )
  })

  test('catalogue promotion preserves a step reached through a production sequence', () => {
    const d = database()
    const current = productionStepCatalogue(d).definition
    const lens = current.steps.find(({ slug }) => slug === 'lens')!
    const withSequence = setStepCatalogue(
      {
        steps: [...current.steps, { ...lens, slug: 'sequence-only' }],
        sequences: [{ slug: 'quality', title: 'Quality', steps: ['sequence-only'] }],
      },
      'add sequence step',
      'test',
      d,
    )
    promoteStepCatalogue(withSequence.n, 'publish', 'test', d)
    const flow = setWorkflow(
      'sequence-step-guard',
      {
        ...valid(),
        modes: [{ ...valid().modes[0]!, steps: [{ sequence: 'quality' }] }],
      },
      'use sequence',
      'test',
      d,
    )
    promoteWorkflow('sequence-step-guard', flow.n, 'publish', 'test', d)
    const withoutReachedStep = setStepCatalogue(
      {
        steps: current.steps,
        sequences: [{ slug: 'quality', title: 'Quality', steps: ['lens'] }],
      },
      'drop reached step',
      'test',
      d,
    )
    expect(() => promoteStepCatalogue(withoutReachedStep.n, 'publish', 'test', d)).toThrow(
      'sequence-step-guard: sequence-only',
    )
  })

  test('workflow promotion refuses a sequence absent from production', () => {
    const d = database()
    const current = productionStepCatalogue(d).definition
    const withSequence = setStepCatalogue(
      {
        steps: current.steps,
        sequences: [{ slug: 'quality', title: 'Quality', steps: ['lens'] }],
      },
      'add sequence',
      'test',
      d,
    )
    promoteStepCatalogue(withSequence.n, 'publish', 'test', d)
    const draft = setWorkflow(
      'sequence-draft',
      {
        ...valid(),
        modes: [{ ...valid().modes[0]!, steps: [{ sequence: 'quality' }] }],
      },
      'use sequence',
      'test',
      d,
    )
    const withoutSequence = setStepCatalogue(
      { steps: current.steps },
      'drop unused sequence',
      'test',
      d,
    )
    promoteStepCatalogue(withoutSequence.n, 'publish', 'test', d)
    expect(() => promoteWorkflow('sequence-draft', draft.n, 'publish', 'test', d)).toThrow(
      'sequence "quality" is absent from the catalogue',
    )
  })
})
