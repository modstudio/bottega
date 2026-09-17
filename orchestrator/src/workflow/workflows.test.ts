import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogue,
  setStepCatalogue,
} from './step-catalogue.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import {
  composeWorkflow,
  getWorkflowStep,
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
  arguments: [{ name: 'key', required: true, description: 'Task key' }],
  modes: [{ slug: 'default', title: 'Default', default: true, steps: ['lens'] }],
})
const release = {
  rungs: [{ name: 'production', branch: 'production', deploy: 'bun run deploy' }],
  mergeMethod: 'squash' as const,
  deployCommand: 'bun run deploy',
  requiredChecks: ['gate'],
  observationWindowHours: 24,
}
const database = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  seedWorkflows(d)
  d.query('INSERT INTO project (name,path,stack,settings) VALUES (?,?,?,?)').run(
    'fixture',
    '/fixture',
    'bun',
    JSON.stringify({ gate: 'bun run check', docs: { protocol: 'orch-docs' } }),
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
          title: 'Search',
          body: 'Search with {{tracker.actions.search}}.',
          floor: ['human-ruling'],
          job: null,
          autonomy: 'ask',
          needs: ['tracker'],
        },
        {
          slug: 'injection-start',
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
  test('validates modes and arguments', () => {
    const d = database(),
      definition = valid()
    definition.modes.push({ slug: 'other', title: 'Other', default: true, steps: ['lens'] })
    expect(validateWorkflowDefinition(definition, d)).toContain(
      'exactly one default mode is allowed',
    )
  })
})

describe('workflow versions and project composition', () => {
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
  test('composes ship with floors and substitutes the project gate', () => {
    const d = database(),
      args = { key: 'DEV-626', branch: 'DEV-626-x', worktree: '/tmp/x' }
    const composed = composeWorkflow('ship', 'fixture', undefined, args, d)
    expect(composed.project).toBe('fixture')
    expect(composed.catalogue.version).toBe(1)
    expect(composed.steps.every((step) => step.floor.length > 0)).toBe(true)
    expect(getWorkflowStep('ship', 'fixture', 'rebase', args, d).body).toContain('bun run check')
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
            title: 'Land',
            body: 'Land on {{trunk}}.',
            floor: ['human-ruling'],
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
            title: 'Release facts',
            body: 'Read the release facts.',
            floor: ['human-ruling'],
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
        tracker: { kind: 'workspace', protocol: 'workspace-mcp' },
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
            title: 'Dedupe',
            body: 'Search with {{tracker.actions.search}}.',
            floor: ['human-ruling'],
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
    expect(() => composeWorkflow('ship', 'fixture', undefined, args, d)).toThrow('gate')
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
    promoteStepCatalogue(draft.n, 'publish', 'a', d)
    expect(() => getWorkflowStep('ship', 'fixture', 'lens', args, d)).toThrow(
      'unresolved workflow placeholder "unknown"',
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
    expect(() => promoteStepCatalogue(draft.n, 'publish', 'a', d)).toThrow('ship: lens')
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
      'references missing step "temp"',
    )
  })
})
