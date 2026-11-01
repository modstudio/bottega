import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { readSqliteKeyTables } from './identity-inventory.ts'
import { stateClassRefusals } from './identity-state-class-check.ts'
import type { StateClassDeclaration } from './identity-state-classes.ts'

const hosted = (
  table: string,
  overrides: Partial<StateClassDeclaration> = {},
): StateClassDeclaration => ({
  store: 'orchestrator',
  table,
  class: 'hosted-first',
  reason: 'test state',
  counterpart: 'hosted_row',
  ...overrides,
})

const refusals = (
  declarations: readonly StateClassDeclaration[],
  options: {
    orchestrator?: readonly string[]
    hub?: readonly string[]
    outboxSources?: readonly string[]
    pushableHubTables?: readonly { hosted: string; local: string }[]
    hostedTables?: readonly string[]
  } = {},
) =>
  stateClassRefusals({
    tables: {
      orchestrator: options.orchestrator ?? ['local_row'],
      hub: options.hub ?? [],
    },
    declarations,
    outboxSources: options.outboxSources ?? [],
    pushableHubTables: options.pushableHubTables ?? [],
    hostedTables: options.hostedTables ?? ['hosted_row'],
  })

describe('stateClassRefusals', () => {
  test('refuses an undeclared migrated table and accepts its declaration', () => {
    const database = new Database(':memory:')
    try {
      database.run('CREATE TABLE declared_row (id TEXT PRIMARY KEY)')
      database.run('CREATE TABLE newly_added_row (id TEXT PRIMARY KEY)')
      const tables = readSqliteKeyTables(database).map((table) => table.name)
      const declarations = [hosted('declared_row')]

      expect(refusals(declarations, { orchestrator: tables })).toContain(
        'orchestrator.newly_added_row: table has no state class declaration; remedy: edit scripts/identity-state-classes.ts',
      )
      expect(
        refusals([...declarations, hosted('newly_added_row')], { orchestrator: tables }),
      ).toEqual([])
    } finally {
      database.close()
    }
  })

  test('refuses duplicate declarations', () => {
    expect(refusals([hosted('local_row'), hosted('local_row')])).toContain(
      'orchestrator.local_row: table has 2 state class declarations; remedy: edit scripts/identity-state-classes.ts so it has exactly one row',
    )
  })

  test('refuses stale declarations', () => {
    expect(refusals([hosted('local_row'), hosted('removed_row')])).toContain(
      'orchestrator.removed_row: state class declaration is stale because the table does not exist; remedy: remove its row from scripts/identity-state-classes.ts',
    )
  })

  test('refuses evidence that is not an outbox source', () => {
    expect(
      refusals([hosted('local_row', { class: 'evidence', counterpart: undefined })]),
    ).toContain(
      'orchestrator.local_row: evidence table is not an outbox source; remedy: edit scripts/identity-state-classes.ts with its ruled class',
    )
  })

  test('refuses an outbox source that is not evidence', () => {
    expect(refusals([hosted('local_row')], { outboxSources: ['local_row'] })).toContain(
      'orchestrator.local_row: outbox source is declared hosted-first instead of evidence; remedy: edit scripts/identity-state-classes.ts with class evidence',
    )
  })

  test('refuses the wrong pushable hub class or counterpart', () => {
    const declaration = hosted('task', {
      store: 'hub',
      counterpart: 'other_hosted_row',
    })
    expect(
      refusals([declaration], {
        orchestrator: [],
        hub: ['task'],
        pushableHubTables: [{ hosted: 'hub_task', local: 'task' }],
        hostedTables: ['hub_task', 'other_hosted_row'],
      }),
    ).toContain(
      'hub.task: pushable hub table hub_task must be hosted-first with that counterpart; remedy: edit scripts/identity-state-classes.ts',
    )
  })

  test('refuses hosted-first without exactly one destination', () => {
    expect(refusals([hosted('local_row', { counterpart: undefined })])).toContain(
      'orchestrator.local_row: hosted-first declaration must name exactly one counterpart or task; remedy: edit scripts/identity-state-classes.ts',
    )
  })

  test('refuses a missing hosted counterpart', () => {
    expect(refusals([hosted('local_row', { counterpart: 'missing_row' })])).toContain(
      'orchestrator.local_row: hosted counterpart missing_row does not exist; remedy: edit scripts/identity-state-classes.ts with an existing hosted table',
    )
  })

  test('refuses an invalid task key', () => {
    expect(refusals([hosted('local_row', { counterpart: undefined, task: 'TASK-1' })])).toContain(
      'orchestrator.local_row: hosted task TASK-1 is not a DEV tracker key; remedy: edit scripts/identity-state-classes.ts with a key of the form DEV-<n>',
    )
  })

  test('refuses machine-only state without a reason and ruling', () => {
    expect(
      refusals([
        hosted('local_row', {
          class: 'machine-only',
          counterpart: undefined,
          reason: '',
          ruling: '',
        }),
      ]),
    ).toContain(
      'orchestrator.local_row: machine-only declaration needs a non-empty reason and ruling; remedy: edit scripts/identity-state-classes.ts',
    )
  })
})
