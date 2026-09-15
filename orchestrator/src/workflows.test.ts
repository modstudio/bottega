import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applySchema } from './db.ts'
import {
  composeWorkflow,
  exportWorkflows,
  forkWorkflow,
  getWorkflowStep,
  importWorkflows,
  promoteWorkflow,
  retireWorkflow,
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
  modes: [{ slug: 'default', title: 'Default', default: true, steps: ['work'] }],
  steps: [
    {
      slug: 'work',
      title: 'Work',
      job: 'implement',
      autonomy: 'auto',
      gate: null,
      body: 'Work on {{key}}.',
    },
  ],
})
const database = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applySchema(d)
  return d
}
const temps: string[] = []
afterEach(() => {
  for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('workflow definition validation', () => {
  test('accepts a coherent definition', () =>
    expect(validateWorkflowDefinition(valid())).toEqual([]))
  const cases: [string, (definition: WorkflowDefinition) => void, string][] = [
    [
      'malformed slug',
      (d) => {
        d.steps[0]!.slug = 'Not valid'
      },
      'not well-formed',
    ],
    [
      'duplicate slug',
      (d) => {
        d.steps.push({ ...d.steps[0]! })
      },
      'duplicate step slug',
    ],
    [
      'two defaults',
      (d) => {
        d.modes.push({ slug: 'other', title: 'Other', default: true, steps: ['work'] })
      },
      'exactly one default',
    ],
    [
      'entry beside default',
      (d) => {
        d.modes[0]!.entry = 'Choose me'
      },
      'unreachable entry',
    ],
    [
      'no entry without default',
      (d) => {
        delete d.modes[0]!.default
      },
      'needs an entry question',
    ],
    [
      'empty mode',
      (d) => {
        d.modes[0]!.steps = []
      },
      'at least one step',
    ],
    [
      'missing step',
      (d) => {
        d.modes[0]!.steps = ['missing']
      },
      'references missing step',
    ],
    [
      'orphan step',
      (d) => {
        d.steps.push({ ...d.steps[0]!, slug: 'orphan' })
      },
      'is orphaned',
    ],
    [
      'undeclared argument',
      (d) => {
        d.steps[0]!.body = '{{missing}}'
      },
      'uses undeclared argument',
    ],
    [
      'unknown job',
      (d) => {
        d.steps[0]!.job = 'imaginary'
      },
      'names unknown job',
    ],
    [
      'bad autonomy',
      (d) => {
        ;(d.steps[0] as { autonomy: string }).autonomy = 'sometimes'
      },
      'invalid autonomy',
    ],
    [
      'empty title',
      (d) => {
        d.title = ''
      },
      'title must be non-empty',
    ],
    [
      'non-string body',
      (d) => {
        ;(d.steps[0] as any).body = 42
      },
      'body must be a string',
    ],
    [
      'non-array mode steps',
      (d) => {
        ;(d.modes[0] as any).steps = 'x'
      },
      'steps must be a string array',
    ],
    [
      'non-boolean required',
      (d) => {
        ;(d.arguments[0] as any).required = 'yes'
      },
      'required must be a boolean',
    ],
  ]
  for (const [name, mutate, message] of cases)
    test(name, () => {
      const d = valid()
      mutate(d)
      expect(validateWorkflowDefinition(d).join('\n')).toContain(message)
    })
  test('reports every violation', () => {
    const d = valid()
    d.title = ''
    d.steps[0]!.job = 'imaginary'
    const errors = validateWorkflowDefinition(d)
    expect(errors).toContain('title must be non-empty')
    expect(errors.join('\n')).toContain('unknown job')
  })
})

describe('workflow versions and composition', () => {
  test('set appends immutable versions and transitions are event-provenanced', () => {
    const d = database()
    const first = setWorkflow('test-flow', valid(), 'first', 'author', d)
    const changed = valid()
    changed.title = 'Changed'
    const second = setWorkflow('test-flow', changed, 'second', 'author', d)
    expect([first.n, second.n]).toEqual([1, 2])
    expect(showWorkflow('test-flow', 1, d).definition.title).toBe('A workflow')
    promoteWorkflow('test-flow', 1, 'publish', 'architect', d)
    expect(() => promoteWorkflow('test-flow', 1, 'again', 'architect', d)).toThrow('not a draft')
    promoteWorkflow('test-flow', 2, 'replace', 'architect', d)
    expect(showWorkflow('test-flow', 1, d).status).toBe('retired')
    expect(showWorkflow('test-flow', 2, d).status).toBe('production')
    retireWorkflow('test-flow', 2, 'withdraw', 'architect', d)
    const versions = workflowVersions('test-flow', d)
    expect(versions[1]!.events.map((e: any) => e.event)).toEqual(['set', 'promote', 'retire'])
    expect(() => setWorkflow('x', valid(), '', 'author', d)).toThrow('reason is required')
  })
  test('fork copies a selected version into a new draft', () => {
    const d = database()
    setWorkflow('forked', valid(), 'set', 'a', d)
    promoteWorkflow('forked', 1, 'go', 'a', d)
    const fork = forkWorkflow('forked', undefined, 'revise', 'a', d)
    expect(fork.n).toBe(2)
    expect(fork.definition).toEqual(valid())
  })
  test('compose is lean and reports mode and argument needs', () => {
    const d = database()
    setWorkflow('compose', valid(), 'set', 'a', d)
    expect(() => composeWorkflow('compose', undefined, { key: 'DEV-257' }, d)).toThrow(
      'workflow "compose" has no production version; promote one',
    )
    expect(() => getWorkflowStep('compose', 'work', { key: 'DEV-257' }, d)).toThrow(
      'workflow "compose" has no production version; promote one',
    )
    promoteWorkflow('compose', 1, 'go', 'a', d)
    const composed = composeWorkflow('compose', undefined, { key: 'DEV-257' }, d)
    expect(composed.mode?.slug).toBe('default')
    expect(JSON.stringify(composed)).not.toContain('Work on')
    expect(composeWorkflow('compose', undefined, {}, d).needs.arguments).toEqual(['key'])
    const noDefault = valid()
    delete noDefault.modes[0]!.default
    noDefault.modes[0]!.entry = 'Which path?'
    setWorkflow('choose', noDefault, 'set', 'a', d)
    promoteWorkflow('choose', 1, 'go', 'a', d)
    expect(composeWorkflow('choose', undefined, { key: 'x' }, d).needs.mode?.[0]?.entry).toBe(
      'Which path?',
    )
  })
  test('step fetch substitutes and requires arguments', () => {
    const d = database()
    setWorkflow('stepper', valid(), 'set', 'a', d)
    promoteWorkflow('stepper', 1, 'go', 'a', d)
    expect(getWorkflowStep('stepper', 'work', { key: 'DEV-257' }, d).body).toBe('Work on DEV-257.')
    expect(() => getWorkflowStep('stepper', 'work', {}, d)).toThrow(
      'missing required arguments: key',
    )
  })
})

describe('workflow export and import', () => {
  test('export is byte-identical and import writes drafts', () => {
    const d = database()
    const dir = mkdtempSync(join(tmpdir(), 'workflow-export-'))
    temps.push(dir)
    exportWorkflows(dir, d)
    const snapshot = (root: string) =>
      readdirSync(root, { recursive: true })
        .filter((p) => statSync(join(root, String(p))).isFile())
        .sort()
        .map((p) => [p, readFileSync(join(root, String(p)), 'utf8')])
    const once = snapshot(dir)
    exportWorkflows(dir, d)
    expect(snapshot(dir)).toEqual(once)
    const target = database()
    importWorkflows(dir, 'round trip', 'a', target)
    expect(showWorkflow('ship', 2, target).status).toBe('draft')
  })
})
