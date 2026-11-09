import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { readSqliteKeyTables } from './identity-inventory.ts'
import { stateClassRefusals } from './identity-state-class-check.ts'
import type { StateClassDeclaration, TableStateClassDeclaration } from './identity-state-classes.ts'

const hosted = (
  table: string,
  overrides: Partial<TableStateClassDeclaration> = {},
): TableStateClassDeclaration => ({
  store: 'orchestrator',
  table,
  class: 'hosted',
  reason: 'test state',
  counterpart: 'hosted_row',
  ...overrides,
})

const refusals = (
  declarations: readonly StateClassDeclaration[],
  options: {
    orchestrator?: readonly string[]
    hub?: readonly string[]
    outboxTables?: readonly string[]
    pushableHubTables?: readonly { hosted: string; local: string }[]
    hostedTables?: readonly string[]
    allowedHostedOutbox?: readonly string[]
    allowedHostedCaches?: readonly string[]
  } = {},
) =>
  stateClassRefusals({
    tables: {
      orchestrator: options.orchestrator ?? ['local_row'],
      hub: options.hub ?? [],
    },
    declarations,
    outboxTables: options.outboxTables ?? [],
    pushableHubTables: options.pushableHubTables ?? [],
    hostedTables: options.hostedTables ?? ['hosted_row'],
    allowedHostedOutbox: options.allowedHostedOutbox ?? [],
    allowedHostedCaches: options.allowedHostedCaches ?? [],
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

  test('refuses synced that is not an outbox source', () => {
    expect(refusals([hosted('local_row', { class: 'synced', counterpart: undefined })])).toContain(
      'orchestrator.local_row: synced table is not an outbox source and names no task for its hosted home; remedy: edit scripts/identity-state-classes.ts with its task',
    )
  })

  test('refuses a hosted table with a new outbox kind', () => {
    expect(refusals([hosted('local_row')], { outboxTables: ['orchestrator.local_row'] })).toContain(
      'orchestrator.local_row: hosted table has a new outbox write path; remedy: write it directly or remove the outbox kind',
    )
  })

  test('refuses a new cache of a hosted table', () => {
    expect(refusals([hosted('local_row', { cache: true })])).toContain(
      'orchestrator.local_row: hosted table has a new local cache; remedy: read it from the hosted record instead',
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
      'hub.task: pushable hub table hub_task must be hosted with that counterpart; remedy: edit scripts/identity-state-classes.ts',
    )
  })

  test('refuses hosted without exactly one destination', () => {
    expect(refusals([hosted('local_row', { counterpart: undefined })])).toContain(
      'orchestrator.local_row: hosted declaration must name exactly one counterpart or task; remedy: edit scripts/identity-state-classes.ts',
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

  test('refuses machine state without a reason and ruling', () => {
    expect(
      refusals([
        hosted('local_row', {
          class: 'machine',
          counterpart: undefined,
          reason: '',
          ruling: '',
        }),
      ]),
    ).toContain(
      'orchestrator.local_row: machine declaration needs a non-empty reason and ruling; remedy: edit scripts/identity-state-classes.ts',
    )
  })

  test('refuses machine state files without their ruling', () => {
    expect(
      refusals([
        hosted('local_row'),
        {
          store: 'state-directory',
          path: 'orchestrator/local-state.json',
          class: 'machine',
          reason: 'Local state',
          ruling: '',
        },
      ]),
    ).toContain(
      'state-directory.orchestrator/local-state.json: machine declaration needs a non-empty reason and ruling; remedy: edit scripts/identity-state-classes.ts',
    )
  })
})
