import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'
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
