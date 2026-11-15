import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const questionNumberDedupeSql = readFileSync(
  join(
    import.meta.dir,
    '..',
    '..',
    'shared',
    'record',
    'migrations',
    '20261115232855_dev_2346_question_number_dedupe',
    'migration.sql',
  ),
  'utf8',
)

const ids = {
  spaceA: '01990000-0000-7000-8000-000000002346',
  spaceB: '01990000-0000-7000-8000-000000002347',
  machine: '01990000-0000-7000-8000-000000002348',
  aKeeper: '01990000-0000-7000-8000-000000002349',
  aFirstLoser: '01990000-0000-7000-8000-00000000234a',
  aSecondLoser: '01990000-0000-7000-8000-00000000234b',
  aMaximum: '01990000-0000-7000-8000-00000000234c',
  aNull: '01990000-0000-7000-8000-00000000234d',
  bKeeper: '01990000-0000-7000-8000-00000000234e',
  bLoser: '01990000-0000-7000-8000-00000000234f',
  bMaximum: '01990000-0000-7000-8000-000000002350',
} as const

export function registerQuestionNumberMigrationProof(input: { admin(statement: string): string }) {
  test('question number dedupe preserves rows and advances each space counter', () => {
    expect(
      input.admin(
        "SELECT count(*) FROM pg_indexes WHERE indexname='question_space_number_unique';",
      ),
    ).toBe('1')
    const setup = `
      CREATE TEMP TABLE question (LIKE public.question INCLUDING DEFAULTS);
      CREATE TEMP TABLE question_number_counter
        (LIKE public.question_number_counter INCLUDING DEFAULTS);
      ALTER TABLE question_number_counter ADD UNIQUE (space_id);
      INSERT INTO question
        (id,number,space_id,machine_id,revision,asked_at,question,withheld_fields,created_at,updated_at)
      VALUES
        ('${ids.aKeeper}',7,'${ids.spaceA}','${ids.machine}',1,'2026-11-15T01:00:00Z','a keeper','[]',now(),now()),
        ('${ids.aFirstLoser}',7,'${ids.spaceA}','${ids.machine}',1,'2026-11-15T02:00:00Z','a first loser','[]',now(),now()),
        ('${ids.aSecondLoser}',7,'${ids.spaceA}','${ids.machine}',1,'2026-11-15T02:00:00Z','a second loser','[]',now(),now()),
        ('${ids.aMaximum}',20,'${ids.spaceA}','${ids.machine}',1,'2026-11-15T03:00:00Z','a maximum','[]',now(),now()),
        ('${ids.aNull}',NULL,'${ids.spaceA}','${ids.machine}',1,'2026-11-15T04:00:00Z','a null','[]',now(),now()),
        ('${ids.bKeeper}',3,'${ids.spaceB}','${ids.machine}',1,'2026-11-15T01:00:00Z','b keeper','[]',now(),now()),
        ('${ids.bLoser}',3,'${ids.spaceB}','${ids.machine}',1,'2026-11-15T02:00:00Z','b loser','[]',now(),now()),
        ('${ids.bMaximum}',9,'${ids.spaceB}','${ids.machine}',1,'2026-11-15T03:00:00Z','b maximum','[]',now(),now());
      INSERT INTO question_number_counter (space_id,next)
      VALUES ('${ids.spaceA}',31),('${ids.spaceB}',15);
    `
    const assertions = `
      WITH allocated AS (
        INSERT INTO question_number_counter (space_id,next)
        VALUES (
          '${ids.spaceA}',
          COALESCE((SELECT MAX(number)::bigint + 2 FROM question WHERE space_id='${ids.spaceA}'),2)
        )
        ON CONFLICT (space_id) DO UPDATE SET next=GREATEST(
          question_number_counter.next,
          COALESCE((SELECT MAX(number)::bigint + 1 FROM question WHERE space_id='${ids.spaceA}'),1)
        ) + 1
        RETURNING next - 1 AS number
      )
      SELECT json_build_object(
        'rowCount',(SELECT count(*) FROM question),
        'aKeeper',(SELECT number FROM question WHERE id='${ids.aKeeper}'),
        'aFirstLoser',(SELECT number FROM question WHERE id='${ids.aFirstLoser}'),
        'aSecondLoser',(SELECT number FROM question WHERE id='${ids.aSecondLoser}'),
        'aNull',(SELECT number IS NULL FROM question WHERE id='${ids.aNull}'),
        'bKeeper',(SELECT number FROM question WHERE id='${ids.bKeeper}'),
        'bLoser',(SELECT number FROM question WHERE id='${ids.bLoser}'),
        'distinctNumbers',(SELECT count(DISTINCT (space_id,number)) FROM question WHERE number IS NOT NULL),
        'allocated',(SELECT number FROM allocated),
        'aNext',(SELECT next FROM question_number_counter WHERE space_id='${ids.spaceA}'),
        'bNext',(SELECT next FROM question_number_counter WHERE space_id='${ids.spaceB}')
      );
    `
    const output = input.admin([setup, questionNumberDedupeSql, assertions].join('\n'))

    expect(JSON.parse(output)).toEqual({
      rowCount: 8,
      aKeeper: 7,
      aFirstLoser: 31,
      aSecondLoser: 32,
      aNull: true,
      bKeeper: 3,
      bLoser: 15,
      distinctNumbers: 7,
      allocated: 33,
      aNext: 34,
      bNext: 16,
    })
  })
}
