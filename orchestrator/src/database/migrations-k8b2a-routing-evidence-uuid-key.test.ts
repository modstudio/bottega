import { expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const MIGRATION = '0154_routing_evidence_uuid_keys'
const ids = {
  runA: '01990000-0000-7000-8000-000000001681',
  runB: '01990000-0000-7000-8000-000000001682',
  blocker: '01990000-0000-7000-8000-000000001683',
  calibration: '01990000-0000-7000-8000-000000001684',
  canonEval: '01990000-0000-7000-8000-000000001685',
  duel: '01990000-0000-7000-8000-000000001686',
  score: '01990000-0000-7000-8000-000000001687',
} as const

const tables = ['blocker', 'calibration', 'canon_eval', 'duel', 'score'] as const

test('K8b-2a makes routing evidence UUIDs primary keys without losing rows or indexes', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  try {
    database.exec(`
      INSERT INTO run(record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
      VALUES ('${ids.runA}',1681,'run-a','codex','implement','sha-a',1,'a','ok'),
             ('${ids.runB}',1682,'run-b','codex','implement','sha-b',2,'b','ok');
      INSERT INTO blocker(record_id,run_record_id,at,what,why,impact,source,kind)
      VALUES ('${ids.blocker}','${ids.runA}','blocker-at','kept-what','kept-why','kept-impact','detected','environment');
      INSERT INTO calibration(record_id,run_record_id,delivery,quality,fidelity,at,session_id)
      VALUES ('${ids.calibration}','${ids.runA}','full','right','faithful','calibration-at','kept-session');
      INSERT INTO canon_eval(record_id,slug,run_record_id,canon_sha,agent,model,pass,why,at)
      VALUES ('${ids.canonEval}','kept-slug','${ids.runA}','kept-sha','codex','kept-model',1,'kept-why','eval-at');
      INSERT INTO duel(record_id,job,winner_run_record_id,loser_run_record_id,session_id,at)
      VALUES ('${ids.duel}','implement','${ids.runA}','${ids.runB}','kept-session','duel-at');
      INSERT INTO score(record_id,run_record_id,delivery,quality,fidelity,note,scored_at,scored_by)
      VALUES ('${ids.score}','${ids.runB}','partial','mixed','partial','kept-note','score-at','kept-scorer');
    `)

    expect(applyMigrations(database)).toContain(MIGRATION)

    for (const table of tables) {
      expect(
        database
          .query<{ name: string; notnull: number; pk: number }, []>(
            `SELECT name,"notnull",pk FROM pragma_table_info('${table}') WHERE name='record_id'`,
          )
          .get(),
      ).toEqual({ name: 'record_id', notnull: 1, pk: 1 })
      expect(
        database.query(`SELECT name FROM pragma_table_info('${table}') WHERE name='id'`).get(),
      ).toBeNull()
      expect(database.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 1 })
    }

    expect(database.query('SELECT * FROM blocker').get()).toEqual({
      record_id: ids.blocker,
      run_record_id: ids.runA,
      at: 'blocker-at',
      what: 'kept-what',
      why: 'kept-why',
      impact: 'kept-impact',
      source: 'detected',
      kind: 'environment',
    })
    expect(database.query('SELECT * FROM calibration').get()).toEqual({
      record_id: ids.calibration,
      run_record_id: ids.runA,
      delivery: 'full',
      quality: 'right',
      fidelity: 'faithful',
      at: 'calibration-at',
      session_id: 'kept-session',
    })
    expect(database.query('SELECT * FROM canon_eval').get()).toEqual({
      record_id: ids.canonEval,
      slug: 'kept-slug',
      run_record_id: ids.runA,
      canon_sha: 'kept-sha',
      agent: 'codex',
      model: 'kept-model',
      pass: 1,
      why: 'kept-why',
      at: 'eval-at',
    })
    expect(database.query('SELECT * FROM duel').get()).toEqual({
      record_id: ids.duel,
      job: 'implement',
      winner_run_record_id: ids.runA,
      loser_run_record_id: ids.runB,
      session_id: 'kept-session',
      at: 'duel-at',
    })
    expect(database.query('SELECT * FROM score').get()).toEqual({
      record_id: ids.score,
      number: 1,
      run_record_id: ids.runB,
      delivery: 'partial',
      quality: 'mixed',
      fidelity: 'partial',
      note: 'kept-note',
      scored_at: 'score-at',
      scored_by: 'kept-scorer',
    })

    const indexNames = Object.fromEntries(
      tables.map((table) => [
        table,
        database
          .query<{ name: string }, []>(`SELECT name FROM pragma_index_list('${table}')`)
          .all()
          .map((row) => row.name),
      ]),
    )
    expect(indexNames.blocker).toEqual(expect.arrayContaining(['blocker_kind', 'blocker_run']))
    expect(indexNames.calibration).toContain('calibration_run_record_id_idx')
    expect(indexNames.canon_eval).toContain('canon_eval_run_record_id_idx')
    expect(indexNames.duel).toEqual(
      expect.arrayContaining(['duel_job', 'duel_loser_run_record_id_idx']),
    )
    expect(indexNames.score).toEqual(expect.arrayContaining(['score_one_per_run', 'score_run']))
    database
      .query(
        `INSERT INTO score(record_id,run_record_id,delivery,quality,fidelity,note,scored_at,scored_by)
         VALUES ('01990000-0000-7000-8000-000000001688','${ids.runA}','full','right','faithful',NULL,'new-score-at','new-scorer')`,
      )
      .run()
    expect(
      database
        .query('SELECT number FROM score WHERE record_id=?')
        .get('01990000-0000-7000-8000-000000001688'),
    ).toEqual({ number: 2 })
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    database.close()
  }
})
