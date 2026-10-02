import { describe, expect, test } from 'bun:test'
import {
  compensationPlan,
  creationOrder,
  destroyPlan,
  lifecycleFailure,
  serveUndoPlan,
  sharedDeclarations,
  teardownVars,
} from './recipe-lifecycle.ts'
import type { TrackedRecipe } from './recipe-schema.ts'
import type { Step, StepResult } from './recipe-step.ts'

const command = { command: 'true', args: [] }
const step = (name: string, undo = true): Step => ({
  name,
  run: command,
  ...(undo ? { undo: command } : {}),
})
const recipe = (extra: Partial<TrackedRecipe> = {}): TrackedRecipe => ({ create: [], ...extra })

describe('tracked recipe lifecycle planning', () => {
  test('orders built-in databases after env files and before project create steps', () => {
    expect(
      creationOrder({
        allocate: {
          databases: {
            app: {
              engine: 'postgres',
              name: 'app',
              provision: {
                from: 'base',
                connection: { key: 'DATABASE_URL', file: '.env' },
                reuse: false,
              },
            },
          },
        },
        create: [step('migrate')],
      }),
    ).toEqual(['env files', 'database app', 'migrate'])
  })
  test('renders shared declarations without adding them to destroy planning', () => {
    const plain = recipe({ create: [step('create')] })
    const shared = recipe({
      create: plain.create,
      shared: [
        { name: 'vendor', kind: 'path', from: 'vendor', at: 'vendor' },
        { name: 'cache', kind: 'volume', from: 'cache', at: 'cache' },
        { name: 'edge', kind: 'network', from: 'edge', at: 'edge' },
        { name: 'redis', kind: 'service', from: 'redis', at: 'redis' },
      ],
    })
    expect(sharedDeclarations(shared)).toEqual([
      'path vendor: vendor -> vendor (shared; not created or removed by this run)',
      'volume cache: cache -> cache (shared; not created or removed by this run)',
      'network edge: edge -> edge (shared; not created or removed by this run)',
      'service redis: redis -> redis (shared; not created or removed by this run)',
    ])
    expect(destroyPlan(shared)).toEqual(destroyPlan(plain))
  })

  test('accepts serve and plans modes in declaration order with steps reversed', () => {
    const input = recipe({
      serve: {
        preview: [step('preview-zero'), step('preview-one')],
        default: [step('default-zero'), step('default-one')],
      },
    })
    expect(serveUndoPlan(input).map((item) => item.name)).toEqual([
      'preview-one',
      'preview-zero',
      'default-one',
      'default-zero',
    ])
  })

  test('compensates the failed step and earlier undoable steps in reverse', () => {
    const input = recipe({
      create: [step('zero'), step('skip', false), step('two'), step('later')],
    })
    expect(compensationPlan(input, 2).map((item) => item.name)).toEqual(['two', 'zero'])
  })

  test('uses explicit destroy steps, otherwise reverse create undos', () => {
    expect(
      destroyPlan(recipe({ create: [step('zero'), step('one')] })).map((x) => [
        x.step.name,
        x.phase,
      ]),
    ).toEqual([
      ['one', 'undo'],
      ['zero', 'undo'],
    ])
    expect(
      destroyPlan(recipe({ create: [step('create')], destroy: [step('destroy', false)] })),
    ).toEqual([{ step: step('destroy', false), phase: 'run' }])
  })

  test('selects the first non-ok result', () => {
    const result = (name: string, status: StepResult['status']): StepResult => ({
      name,
      status,
      phase: 'run',
      exitCode: status === 'ok' ? 0 : 1,
      argv: [],
      detail: name,
      durationMs: 0,
    })
    expect(
      lifecycleFailure([result('ok', 'ok'), result('first', 'failed'), result('second', 'refused')])
        ?.name,
    ).toBe('first')
  })

  test('teardown variables restore every allocation recorded in the snapshot', () => {
    expect(
      teardownVars({
        path: '/trees/one',
        branch: 'DEV-577',
        base: 'abc',
        key: 'DEV-577',
        seed: null,
        main: '/main',
        label: 'orch.run=2',
        treeExists: true,
        allocations: {
          index: 3,
          ports: { web: 21002 },
          databases: { app: 'app_3' },
          strings: { cookie: 'tree-3' },
        },
      }),
    ).toMatchObject({
      index: '3',
      label: 'orch.run=2',
      tree_exists: 'true',
      'ports.web': '21002',
      'db.app': 'app_3',
      'alloc.cookie': 'tree-3',
    })
  })
})
