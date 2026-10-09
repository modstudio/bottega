// concern: record-doc-audience-sql
/** Binds hosted document audiences as a Postgres text[] parameter. */
import type { SQL } from 'bun'
import type { DocAudiences } from '../../../shared/docs.ts'

export function bindRecordDocAudiences(sql: Pick<SQL, 'array'>, audiences: DocAudiences) {
  return sql.array([...audiences], 'text')
}
