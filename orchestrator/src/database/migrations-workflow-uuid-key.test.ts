import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId, replicatedRecordId } from '../../../shared/record-id.ts'
import { applyMigrations, applyMigrationsBefore } from './migrations.ts'
import { workflowStaleCopyPreflight } from './workflow-uuid-migration-preflight.ts'

const TABLES = [
  'workflow',
  'workflow_version',
  'workflow_event',
  'workflow_cursor',
  'workflow_obligation',
  'workflow_step_text',
  'step_catalogue',
  'step_catalogue_version',
  'step_catalogue_event',
] as const

let beforeTemplate: Uint8Array | undefined

function before(): Database {
  if (!beforeTemplate) {
    const database = new Database(':memory:')
    applyMigrationsBefore(database, '0157_workflow_uuid_key')
    beforeTemplate = database.serialize()
    database.close()
  }
  const database = Database.deserialize(beforeTemplate)
  database.exec('PRAGMA foreign_keys=ON')
  return database
}

function seedLegacyWorkflowTables(d: Database): void {
  const at = '2026-10-23T00:00:00.000Z'
  for (const [owner, version, event, foreign, slug] of [
    ['workflow', 'workflow_version', 'workflow_event', 'workflow_id', 'ship-task'],
    ['step_catalogue', 'step_catalogue_version', 'step_catalogue_event', 'catalogue_id', 'shared'],
  ] as const) {
    d.query(
      `INSERT INTO ${owner}(record_id,slug,created_at,space_id,generation) VALUES (?,?,?,NULL,1)`,
    ).run(newRecordId(), slug, at)
    const ownerId = Number(d.query<{ id: number }, []>('SELECT last_insert_rowid() id').get()!.id)
    d.query(
      `INSERT INTO ${version}(record_id,${foreign},n,status,definition,author,reason,created_at,promoted_at,space_id) VALUES (?,?,1,'production','{}','seed','fixture',?,?,NULL)`,
    ).run(newRecordId(), ownerId, at, at)
    d.query(
      `INSERT INTO ${event}(record_id,${foreign},version_n,event,author,reason,at,space_id) VALUES (?,?,1,'set','seed','fixture',?,NULL)`,
    ).run(newRecordId(), ownerId, at)
  }
}

const TWIN_CONFIGS = [
  {
    owner: 'workflow',
    version: 'workflow_version',
    event: 'workflow_event',
    foreign: 'workflow_id',
    kind: 'workflow',
  },
  {
    owner: 'step_catalogue',
    version: 'step_catalogue_version',
    event: 'step_catalogue_event',
    foreign: 'catalogue_id',
    kind: 'step_catalogue',
  },
] as const

type TwinConfig = (typeof TWIN_CONFIGS)[number]
type TwinOptions = {
  divergent?: boolean
  divergentReason?: boolean
  omitEvents?: boolean
  hostedStatus?: 'draft' | 'production' | 'retired'
  lifecycleBookkeepingDiffers?: boolean
}

function installDerivedEvents(
  d: Database,
  space: string,
  config: TwinConfig,
  localOwnerId: number,
  hostedOwnerId: number,
  versionN: number,
  lifecycleBookkeepingDiffers: boolean,
): void {
  const events = d
    .query<Record<string, string | number | null>, [number, number]>(
      `SELECT * FROM ${config.event} WHERE ${config.foreign}=? AND version_n=? AND space_id IS NULL`,
    )
    .all(localOwnerId, versionN)
  for (const event of events)
    d.query(
      `INSERT INTO ${config.event}(record_id,${config.foreign},version_n,event,author,reason,session_id,at,space_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      replicatedRecordId(space, `${config.kind}_event`, String(event.record_id)),
      hostedOwnerId,
      Number(event.version_n),
      String(event.event),
      lifecycleBookkeepingDiffers ? 'hosted-event-author' : String(event.author),
      lifecycleBookkeepingDiffers ? 'hosted-event-reason' : String(event.reason),
      event.session_id ?? null,
      lifecycleBookkeepingDiffers ? 'hosted-event-at' : String(event.at),
      space,
    )
}

function installDerivedTwin(
  d: Database,
  space: string,
  config: TwinConfig,
  options: TwinOptions,
): void {
  const local = d
    .query<{ id: number; record_id: string; slug: string; created_at: string }, []>(
      `SELECT id,record_id,slug,created_at FROM ${config.owner} WHERE space_id IS NULL`,
    )
    .get()!
  const version = d
    .query<Record<string, string | number | null>, [number]>(
      `SELECT * FROM ${config.version} WHERE ${config.foreign}=?`,
    )
    .get(local.id)!
  d.query(
    `INSERT INTO ${config.owner}(record_id,slug,created_at,space_id,generation) VALUES (?,?,?,?,1)`,
  ).run(
    replicatedRecordId(space, config.kind, local.record_id),
    local.slug,
    local.created_at,
    space,
  )
  const hostedOwnerId = Number(
    d.query<{ id: number }, []>('SELECT last_insert_rowid() id').get()!.id,
  )
  const bookkeepingDiffers = options.lifecycleBookkeepingDiffers ?? false
  d.query(
    `INSERT INTO ${config.version}(record_id,${config.foreign},n,status,definition,author,reason,created_at,promoted_at,retired_at,space_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    replicatedRecordId(space, `${config.kind}_version`, String(version.record_id)),
    hostedOwnerId,
    Number(version.n),
    options.hostedStatus ?? String(version.status),
    options.divergent ? '{"different":true}' : String(version.definition),
    bookkeepingDiffers ? 'hosted-author' : String(version.author),
    options.divergentReason ? 'different authored reason' : String(version.reason),
    bookkeepingDiffers ? 'hosted-created' : String(version.created_at),
    bookkeepingDiffers ? 'hosted-promoted' : (version.promoted_at ?? null),
    bookkeepingDiffers ? 'hosted-retired' : (version.retired_at ?? null),
    space,
  )
  if (!options.omitEvents)
    installDerivedEvents(
      d,
      space,
      config,
      local.id,
      hostedOwnerId,
      Number(version.n),
      bookkeepingDiffers,
    )
}

function installDerivedTwins(d: Database, space: string, options: TwinOptions = {}): void {
  for (const config of TWIN_CONFIGS) installDerivedTwin(d, space, config, options)
}

test('workflow UUID-key migration rebuilds all nine tables and their catalogue relationships', () => {
  const d = before()
  try {
    seedLegacyWorkflowTables(d)
    applyMigrations(d)
    for (const table of TABLES) {
      expect(
        d
          .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}') WHERE pk=1`)
          .get(),
        table,
      ).toEqual({ name: 'record_id' })
    }
    expect(d.query('PRAGMA foreign_key_check').all()).toEqual([])
    expect(
      d
        .query(
          'SELECT COUNT(*) n FROM workflow_version v JOIN workflow w ON w.record_id=v.workflow_record_id',
        )
        .get(),
    ).toEqual(d.query('SELECT COUNT(*) n FROM workflow_version').get())
    expect(
      d
        .query(
          'SELECT COUNT(*) n FROM workflow_event e JOIN workflow_version v ON v.record_id=e.workflow_version_record_id',
        )
        .get(),
    ).toEqual(d.query('SELECT COUNT(*) n FROM workflow_event').get())
  } finally {
    d.close()
  }
})

test('bound workflow UUID-key migration accepts content twins and removes NULL-space rows', () => {
  const d = before()
  const space = newRecordId()
  try {
    seedLegacyWorkflowTables(d)
    d.query("INSERT INTO schema_meta(key,value) VALUES ('record_active_space',?)").run(space)
    d.query("INSERT INTO schema_meta(key,value) VALUES ('record_project_spaces','{}')").run()
    for (const [owner, version, event, foreign] of [
      ['workflow', 'workflow_version', 'workflow_event', 'workflow_id'],
      ['step_catalogue', 'step_catalogue_version', 'step_catalogue_event', 'catalogue_id'],
    ] as const) {
      const owners = d.query(`SELECT * FROM ${owner} WHERE space_id IS NULL`).all() as Array<
        Record<string, string | number | null>
      >
      for (const local of owners) {
        d.query(
          `INSERT INTO ${owner}(record_id,slug,created_at,space_id,generation) VALUES (?,?,?,?,?)`,
        ).run(
          newRecordId(),
          String(local.slug),
          String(local.created_at),
          space,
          Number(local.generation),
        )
        const hostedOwner = Number(
          d.query<{ id: number }, []>('SELECT last_insert_rowid() id').get()!.id,
        )
        const versions = d
          .query(`SELECT * FROM ${version} WHERE ${foreign}=? ORDER BY n`)
          .all(local.id!) as Array<Record<string, string | number | null>>
        for (const row of versions)
          d.query(
            `INSERT INTO ${version}(record_id,${foreign},n,status,definition,author,reason,created_at,promoted_at,retired_at,space_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            newRecordId(),
            hostedOwner,
            Number(row.n),
            String(row.status),
            String(row.definition),
            String(row.author),
            String(row.reason),
            String(row.created_at),
            row.promoted_at == null ? null : String(row.promoted_at),
            row.retired_at == null ? null : String(row.retired_at),
            space,
          )
      }
      expect(d.query(`SELECT COUNT(*) n FROM ${event} WHERE space_id IS NULL`).get()).not.toEqual({
        n: 0,
      })
    }
    d.exec("INSERT INTO record_install_binding(id,bound_at) VALUES (1,'2026-10-23T00:00:00.000Z')")
    expect(workflowStaleCopyPreflight(d).supersededEvents).toEqual([
      expect.stringMatching(/^workflow_version:ship-task@1:.* supersedes 1 NULL-space event$/),
      expect.stringMatching(/^step_catalogue_version:shared@1:.* supersedes 1 NULL-space event$/),
    ])
    applyMigrations(d)
    for (const table of [
      'workflow',
      'workflow_version',
      'workflow_event',
      'step_catalogue',
      'step_catalogue_version',
      'step_catalogue_event',
    ])
      expect(
        d.query(`SELECT COUNT(*) n FROM ${table} WHERE space_id IS NULL`).get(),
        table,
      ).toEqual({ n: 0 })
  } finally {
    d.close()
  }
})

test('bound workflow UUID-key migration refuses an unproved stale copy atomically', () => {
  const d = before()
  try {
    seedLegacyWorkflowTables(d)
    d.exec("INSERT INTO record_install_binding(id,bound_at) VALUES (1,'2026-10-23T00:00:00.000Z')")
    expect(() => applyMigrations(d)).toThrow(
      'bound store has NULL-space workflow rows without equivalent hosted twins',
    )
    expect(d.query("SELECT name FROM pragma_table_info('workflow') WHERE name='id'").get()).toEqual(
      { name: 'id' },
    )
  } finally {
    d.close()
  }
})

test('workflow UUID-key migration preserves a rich cursor and rewrites only structured references', () => {
  const d = before()
  const cursorRecordId = newRecordId()
  const obligationRecordId = newRecordId()
  const textRecordId = newRecordId()
  const questionRecordId = newRecordId()
  try {
    seedLegacyWorkflowTables(d)
    const workflowVersion = d
      .query<{ n: number }, []>('SELECT n FROM workflow_version WHERE space_id IS NULL')
      .get()!.n
    const catalogueVersion = d
      .query<{ n: number }, []>('SELECT n FROM step_catalogue_version WHERE space_id IS NULL')
      .get()!.n
    d.query(
      `INSERT INTO workflow_cursor
        (id,record_id,project,workflow_slug,mode_slug,instance_id,session_id,workflow_version,catalogue_version,args,
         ordinal,step_slug,state,closed,total_steps,created_at,updated_at)
       VALUES (77,?,'fixture','ship-task','default','instance','session',?,?,'{}',1,'proof','awaiting-ruling','[]',2,'a','b')`,
    ).run(cursorRecordId, workflowVersion, catalogueVersion)
    d.query(
      `INSERT INTO workflow_obligation
        (record_id,cursor_id,step_ordinal,step_slug,floor,reason,session_id,created_at)
       VALUES (?,77,1,'proof','recorded-artifact','proof','session','a')`,
    ).run(obligationRecordId)
    const obligationId = Number(
      d.query<{ id: number }, []>('SELECT last_insert_rowid() id').get()!.id,
    )
    d.query(
      `INSERT INTO workflow_step_text(record_id,cursor_id,step_ordinal,step_slug,body,created_at)
       VALUES (?,77,1,'proof','artifact','a')`,
    ).run(textRecordId)
    const textId = Number(d.query<{ id: number }, []>('SELECT last_insert_rowid() id').get()!.id)
    const closed = JSON.stringify([
      {
        n: 1,
        slug: 'proof',
        note: 'history mentions missing attached-text:15 and --satisfies 999',
        at: 'a',
        evidence: [{ flag: '--artifact', value: `attached-text:${textId}` }],
        deferred: { id: obligationId, floor: 'recorded-artifact', reason: 'proof' },
        satisfied: String(obligationId),
      },
    ])
    const evidence = JSON.stringify([{ flag: '--artifact', value: `attached-text:${textId}` }])
    d.query('UPDATE workflow_cursor SET closed=? WHERE id=77').run(closed)
    d.query('UPDATE workflow_obligation SET satisfied_evidence=? WHERE id=?').run(
      evidence,
      obligationId,
    )
    d.query(
      `INSERT INTO question
        (record_id,number,workflow_cursor_id,workflow_key,asked_at,question,asked_via,workflow_step_ordinal,workflow_step_slug)
       VALUES (?,91,77,'DEV-1214','a','open?','workflow',1,'proof')`,
    ).run(questionRecordId)

    applyMigrations(d)

    const row = d
      .query<
        { closed: string; workflow_version_record_id: string; catalogue_version_record_id: string },
        []
      >(
        `SELECT closed,workflow_version_record_id,catalogue_version_record_id
           FROM workflow_cursor WHERE record_id='${cursorRecordId}'`,
      )
      .get()!
    const rewritten = JSON.parse(row.closed) as Array<{
      note: string
      evidence: Array<{ value: string }>
      deferred: { id: string }
      satisfied: string
    }>
    expect(rewritten[0]!.note).toBe('history mentions missing attached-text:15 and --satisfies 999')
    expect(rewritten[0]!.evidence[0]!.value).toBe(`attached-text:${textRecordId}`)
    expect(rewritten[0]!.deferred.id).toBe(obligationRecordId)
    expect(rewritten[0]!.satisfied).toBe(obligationRecordId)
    expect(
      d
        .query('SELECT satisfied_evidence FROM workflow_obligation WHERE record_id=?')
        .get(obligationRecordId),
    ).toEqual({
      satisfied_evidence: JSON.stringify([
        { flag: '--artifact', value: `attached-text:${textRecordId}` },
      ]),
    })
    expect(
      d
        .query(
          `SELECT c.number,v.n workflow_version,s.n catalogue_version,t.body,o.floor,q.question
             FROM workflow_cursor c
             JOIN workflow_version v ON v.record_id=c.workflow_version_record_id
             JOIN step_catalogue_version s ON s.record_id=c.catalogue_version_record_id
             JOIN workflow_step_text t ON t.cursor_record_id=c.record_id
             JOIN workflow_obligation o ON o.cursor_record_id=c.record_id
             JOIN question q ON q.workflow_cursor_record_id=c.record_id
            WHERE c.record_id=? AND q.answered_at IS NULL`,
        )
        .get(cursorRecordId),
    ).toEqual({
      number: 77,
      workflow_version: 1,
      catalogue_version: 1,
      body: 'artifact',
      floor: 'recorded-artifact',
      question: 'open?',
    })
    expect(d.query('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    d.close()
  }
})

test('workflow UUID-key migration refuses only missing structured evidence and names the cursor', () => {
  const d = before()
  try {
    seedLegacyWorkflowTables(d)
    d.exec(`
      INSERT INTO workflow_cursor
        (id,record_id,project,workflow_slug,mode_slug,instance_id,workflow_version,catalogue_version,args,closed,total_steps,created_at,updated_at)
      VALUES (78,'${newRecordId()}','fixture','ship-task','default','instance',1,1,'{}','[{"n":1,"slug":"proof","note":"missing attached-text:15","at":"a","evidence":[{"flag":"--artifact","value":"attached-text:16"}]}]',1,'a','a');
    `)
    expect(() => applyMigrations(d)).toThrow(
      'structured workflow evidence names missing rows (workflow_cursor:78)',
    )
    expect(
      d.query("SELECT name FROM pragma_table_info('workflow_cursor') WHERE name='id'").get(),
    ).toEqual({ name: 'id' })
  } finally {
    d.close()
  }
})

test('bound workflow UUID-key migration accepts lossless derived-id twins', () => {
  const d = before()
  const space = newRecordId()
  try {
    seedLegacyWorkflowTables(d)
    d.query("INSERT INTO schema_meta(key,value) VALUES ('record_active_space',?)").run(space)
    d.query("INSERT INTO schema_meta(key,value) VALUES ('record_project_spaces','{}')").run()
    installDerivedTwins(d, space)
    d.exec("INSERT INTO record_install_binding(id,bound_at) VALUES (1,'a')")
    applyMigrations(d)
    expect(d.query('SELECT COUNT(*) n FROM workflow WHERE space_id IS NULL').get()).toEqual({
      n: 0,
    })
    expect(d.query('SELECT COUNT(*) n FROM step_catalogue WHERE space_id IS NULL').get()).toEqual({
      n: 0,
    })
  } finally {
    d.close()
  }
})

test('bound workflow UUID-key migration accepts hosted-ahead lifecycle bookkeeping and event metadata', () => {
  const d = before()
  const space = newRecordId()
  try {
    seedLegacyWorkflowTables(d)
    d.query("INSERT INTO schema_meta(key,value) VALUES ('record_active_space',?)").run(space)
    d.query("INSERT INTO schema_meta(key,value) VALUES ('record_project_spaces','{}')").run()
    installDerivedTwins(d, space, {
      hostedStatus: 'retired',
      lifecycleBookkeepingDiffers: true,
    })
    d.exec("INSERT INTO record_install_binding(id,bound_at) VALUES (1,'a')")
    applyMigrations(d)
    expect(d.query('SELECT COUNT(*) n FROM workflow WHERE space_id IS NULL').get()).toEqual({
      n: 0,
    })
  } finally {
    d.close()
  }
})

test('bound workflow UUID-key migration refuses a NULL-space status ahead of every twin', () => {
  const d = before()
  const space = newRecordId()
  try {
    seedLegacyWorkflowTables(d)
    d.query("INSERT INTO schema_meta(key,value) VALUES ('record_active_space',?)").run(space)
    d.query("INSERT INTO schema_meta(key,value) VALUES ('record_project_spaces','{}')").run()
    installDerivedTwins(d, space, { hostedStatus: 'draft' })
    d.exec("INSERT INTO record_install_binding(id,bound_at) VALUES (1,'a')")
    expect(() => applyMigrations(d)).toThrow('differs in status-ahead')
  } finally {
    d.close()
  }
})

test('bound workflow UUID-key migration refuses a divergent derived-id twin by field', () => {
  const d = before()
  const space = newRecordId()
  try {
    seedLegacyWorkflowTables(d)
    d.query("INSERT INTO schema_meta(key,value) VALUES ('record_active_space',?)").run(space)
    d.query("INSERT INTO schema_meta(key,value) VALUES ('record_project_spaces','{}')").run()
    installDerivedTwins(d, space, { divergent: true })
    d.exec("INSERT INTO record_install_binding(id,bound_at) VALUES (1,'a')")
    expect(() => applyMigrations(d)).toThrow('differs in definition')
  } finally {
    d.close()
  }
})

test('bound workflow UUID-key migration refuses a divergent authored reason', () => {
  const d = before()
  const space = newRecordId()
  try {
    seedLegacyWorkflowTables(d)
    d.query("INSERT INTO schema_meta(key,value) VALUES ('record_active_space',?)").run(space)
    d.query("INSERT INTO schema_meta(key,value) VALUES ('record_project_spaces','{}')").run()
    installDerivedTwins(d, space, { divergentReason: true })
    d.exec("INSERT INTO record_install_binding(id,bound_at) VALUES (1,'a')")
    expect(() => applyMigrations(d)).toThrow('differs in reason')
  } finally {
    d.close()
  }
})

test.each([
  ['workflow', 'workflow_version', 'workflow_event'],
  ['step catalogue', 'step_catalogue_version', 'step_catalogue_event'],
] as const)(
  'bound workflow UUID-key migration refuses a derived-id %s twin with another version number',
  (_, table, eventTable) => {
    const d = before()
    const space = newRecordId()
    try {
      seedLegacyWorkflowTables(d)
      d.query("INSERT INTO schema_meta(key,value) VALUES ('record_active_space',?)").run(space)
      d.query("INSERT INTO schema_meta(key,value) VALUES ('record_project_spaces','{}')").run()
      installDerivedTwins(d, space)
      d.query(`DELETE FROM ${eventTable} WHERE space_id=?`).run(space)
      d.query(`UPDATE ${table} SET n=2 WHERE space_id=?`).run(space)
      d.exec("INSERT INTO record_install_binding(id,bound_at) VALUES (1,'a')")

      expect(() => applyMigrations(d)).toThrow(`differs in n`)
      expect(
        d.query(`SELECT name FROM pragma_table_info('${table}') WHERE name='id'`).get(),
      ).toEqual({
        name: 'id',
      })
    } finally {
      d.close()
    }
  },
)

test('bound workflow UUID-key migration refuses an unmatched derived-id event by name', () => {
  const d = before()
  const space = newRecordId()
  try {
    seedLegacyWorkflowTables(d)
    d.query("INSERT INTO schema_meta(key,value) VALUES ('record_active_space',?)").run(space)
    d.query("INSERT INTO schema_meta(key,value) VALUES ('record_project_spaces','{}')").run()
    installDerivedTwins(d, space, { omitEvents: true })
    d.exec("INSERT INTO record_install_binding(id,bound_at) VALUES (1,'a')")
    const event = d.query<{ record_id: string }, []>('SELECT record_id FROM workflow_event').get()!
    expect(() => applyMigrations(d)).toThrow(`workflow_event:ship-task@1:${event.record_id}`)
  } finally {
    d.close()
  }
})

test('bound workflow UUID-key migration refuses a cursor whose project cannot route to its composing-space twin', () => {
  const d = before()
  const space = newRecordId()
  try {
    seedLegacyWorkflowTables(d)
    d.query("INSERT INTO schema_meta(key,value) VALUES ('record_active_space',?)").run(space)
    d.query("INSERT INTO schema_meta(key,value) VALUES ('record_project_spaces','{}')").run()
    installDerivedTwins(d, space)
    d.query(
      `INSERT INTO workflow_cursor
        (id,record_id,project,workflow_slug,mode_slug,instance_id,workflow_version,catalogue_version,args,total_steps,created_at,updated_at)
       VALUES (79,?,'fixture','ship-task','default','instance',1,1,'{}',1,'a','a')`,
    ).run(newRecordId())
    d.exec("INSERT INTO record_install_binding(id,bound_at) VALUES (1,'a')")
    expect(() => applyMigrations(d)).toThrow(
      'cursors would not resolve after NULL-space deletion (workflow_cursor:79)',
    )
  } finally {
    d.close()
  }
})

test('bound workflow UUID-key migration keeps a cursor routed through the cached project space', () => {
  const d = before()
  const space = newRecordId()
  try {
    seedLegacyWorkflowTables(d)
    d.query("INSERT INTO schema_meta(key,value) VALUES ('record_active_space',?)").run(space)
    d.query("INSERT INTO schema_meta(key,value) VALUES ('record_project_spaces',?)").run(
      JSON.stringify({ fixture: space }),
    )
    installDerivedTwins(d, space)
    d.query(
      `INSERT INTO workflow_cursor
        (id,record_id,project,workflow_slug,mode_slug,instance_id,workflow_version,catalogue_version,args,total_steps,created_at,updated_at)
       VALUES (79,?,'fixture','ship-task','default','instance',1,1,'{}',1,'a','a')`,
    ).run(newRecordId())
    d.exec("INSERT INTO record_install_binding(id,bound_at) VALUES (1,'a')")

    applyMigrations(d)
    expect(d.query('SELECT number FROM workflow_cursor').get()).toEqual({ number: 79 })
  } finally {
    d.close()
  }
})

test.each([
  ['workflow', 'workflow_version'],
  ['step catalogue', 'step_catalogue_version'],
] as const)(
  'bound workflow UUID-key migration refuses a cursor routed to a divergent %s twin',
  (_, divergentTable) => {
    const d = before()
    const activeSpace = newRecordId()
    const routedSpace = newRecordId()
    try {
      seedLegacyWorkflowTables(d)
      d.query("INSERT INTO schema_meta(key,value) VALUES ('record_active_space',?)").run(
        activeSpace,
      )
      d.query("INSERT INTO schema_meta(key,value) VALUES ('record_project_spaces',?)").run(
        JSON.stringify({ fixture: routedSpace }),
      )
      installDerivedTwins(d, activeSpace)
      installDerivedTwins(d, routedSpace)
      d.query(
        `UPDATE ${divergentTable} SET definition='{"routed":"different"}' WHERE space_id=?`,
      ).run(routedSpace)
      d.query(
        `INSERT INTO workflow_cursor
          (id,record_id,project,workflow_slug,mode_slug,instance_id,workflow_version,catalogue_version,args,total_steps,created_at,updated_at)
         VALUES (80,?,'fixture','ship-task','default','instance',1,1,'{}',1,'a','a')`,
      ).run(newRecordId())
      d.exec("INSERT INTO record_install_binding(id,bound_at) VALUES (1,'a')")

      expect(() => applyMigrations(d)).toThrow(
        `cursors would not resolve after NULL-space deletion (workflow_cursor:80 ${divergentTable} differs in definition)`,
      )
    } finally {
      d.close()
    }
  },
)

test('workflow UUID-key migration reports every orphan together and leaves the old schema unchanged', () => {
  const d = before()
  try {
    seedLegacyWorkflowTables(d)
    const workflowId = d.query<{ id: number }, []>('SELECT id FROM workflow').get()!.id
    const catalogueId = d.query<{ id: number }, []>('SELECT id FROM step_catalogue').get()!.id
    d.exec('PRAGMA foreign_keys=OFF')
    d.exec(`
      INSERT INTO workflow_version(record_id,workflow_id,n,status,definition,author,reason,created_at) VALUES ('${newRecordId()}',901,2,'draft','{}','a','r','a');
      INSERT INTO workflow_event(record_id,workflow_id,version_n,event,author,reason,at) VALUES ('${newRecordId()}',${workflowId},99,'set','a','r','a');
      INSERT INTO step_catalogue_version(record_id,catalogue_id,n,status,definition,author,reason,created_at) VALUES ('${newRecordId()}',902,2,'draft','{}','a','r','a');
      INSERT INTO step_catalogue_event(record_id,catalogue_id,version_n,event,author,reason,at) VALUES ('${newRecordId()}',${catalogueId},99,'set','a','r','a');
      INSERT INTO workflow_cursor(id,record_id,project,workflow_slug,mode_slug,instance_id,workflow_version,catalogue_version,args,total_steps,created_at,updated_at) VALUES (903,'${newRecordId()}','fixture','missing','default','instance',99,99,'{}',1,'a','a');
      INSERT INTO workflow_obligation(record_id,cursor_id,step_ordinal,step_slug,floor,reason,created_at) VALUES ('${newRecordId()}',904,1,'proof','recorded-artifact','r','a');
      INSERT INTO workflow_step_text(record_id,cursor_id,step_ordinal,step_slug,body,created_at) VALUES ('${newRecordId()}',905,1,'proof','body','a');
      INSERT INTO question(record_id,number,workflow_cursor_id,asked_at,question) VALUES ('${newRecordId()}',906,906,'a','q');
      INSERT INTO operator_notification(record_id,kind,item_id,episode,notified_at) VALUES ('${newRecordId()}','workflow',907,'e','a');
    `)
    expect(() => applyMigrations(d)).toThrow(
      'workflow_version.workflow_id=1, step_catalogue_version.catalogue_id=1, workflow_obligation.cursor_id=1, workflow_step_text.cursor_id=1, workflow_event.workflow_version_record_id=1, step_catalogue_event.catalogue_version_record_id=1, workflow_cursor.workflow_version_record_id=1, workflow_cursor.catalogue_version_record_id=1, question.workflow_cursor_id=1, operator_notification.item_id=1',
    )
    expect(d.query("SELECT name FROM pragma_table_info('workflow') WHERE name='id'").get()).toEqual(
      { name: 'id' },
    )
  } finally {
    d.close()
  }
})

test('workflow UUID hot reads use their leading indexes', () => {
  const d = before()
  try {
    applyMigrations(d)
    const plan = (sql: string): string =>
      d
        .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map((row) => row.detail)
        .join('\n')
    expect(plan('SELECT * FROM workflow_cursor WHERE number=1')).toContain(
      'sqlite_autoindex_workflow_cursor_2',
    )
    expect(
      plan("SELECT * FROM workflow_cursor WHERE session_id='s' AND state='running'"),
    ).toContain('workflow_cursor_session')
    expect(plan("SELECT * FROM workflow_event WHERE workflow_version_record_id='v'")).toContain(
      'workflow_event_version',
    )
    expect(
      plan("SELECT * FROM workflow_obligation WHERE cursor_record_id='c' AND satisfied_at IS NULL"),
    ).toContain('workflow_obligation_open')
  } finally {
    d.close()
  }
})
