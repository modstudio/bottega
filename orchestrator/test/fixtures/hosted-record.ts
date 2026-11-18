import type { PGlite } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { RECORD_ACTOR_ROLE } from '../../../shared/record/schema.ts'
import { loadHostedRecordSnapshot } from './hosted-record-snapshot.ts'

export async function createHostedRecordFixture(options: {
  spaceId: string
  userId: string
}): Promise<PGlite> {
  const database = await loadHostedRecordSnapshot()
  await database.exec(`
    INSERT INTO space (id,name,slug,created_at)
    VALUES ('${options.spaceId}','Mirror test','mirror-test',now());
    INSERT INTO "user" (id,email,name,created_at)
    VALUES ('${options.userId}','mirror@example.test','Mirror user',now());
    INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
    VALUES ('01990000-0000-7000-8000-000000002199','${options.spaceId}','${options.userId}','member','write',now());
    SET ROLE ${RECORD_ACTOR_ROLE};
    SELECT set_config('app.user_id','${options.userId}',false);
    SELECT set_config('app.space_id','${options.spaceId}',false);
    SELECT set_config('app.space_ids','${options.spaceId}',false);
  `)
  return database
}

type SqlFragment = { readonly sql: string }

function pgliteQuery(database: Pick<PGlite, 'query'>): SQL {
  const result = (statement: string, parameters: unknown[]) => {
    let arrayMode = false
    const rows = Promise.resolve()
      .then(() =>
        database.query(
          statement,
          parameters,
          arrayMode ? { rowMode: 'array' as const } : undefined,
        ),
      )
      .then((value) => value.rows)
    return Object.assign(rows, {
      values: () => {
        arrayMode = true
        return rows
      },
    })
  }
  const query = (strings: TemplateStringsArray, ...interpolations: unknown[]) => {
    let statement = strings[0]!
    const parameters: unknown[] = []
    for (const [index, interpolation] of interpolations.entries()) {
      if (typeof interpolation === 'object' && interpolation !== null && 'sql' in interpolation) {
        statement += (interpolation as SqlFragment).sql
      } else {
        parameters.push(interpolation)
        statement += `$${parameters.length}`
      }
      statement += strings[index + 1]!
    }
    return result(statement, parameters)
  }
  query.options = {}
  query.unsafe = (sql: string, parameters?: unknown[]) => {
    if (parameters === undefined) return { sql }
    return result(sql, parameters)
  }
  return query as unknown as SQL
}

export function pgliteSql(database: PGlite): SQL {
  const query = pgliteQuery(database)
  const begin = <T>(work: (tx: SQL) => Promise<T>) =>
    database.transaction((transaction) => work(pgliteQuery(transaction)))
  query.begin = begin as SQL['begin']
  return query
}
