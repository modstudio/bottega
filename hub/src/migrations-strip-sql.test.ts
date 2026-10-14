import { describe, expect, test } from 'bun:test'
import { stripSqlComments } from './migrations.ts'

describe('stripSqlComments keeps quoted comment markers', () => {
  test('quoted -- and /* survive while real comments are removed', () => {
    expect(stripSqlComments("INSERT INTO t (v) VALUES ('a -- b'); -- seed\n")).toBe(
      "INSERT INTO t (v) VALUES ('a -- b'); \n",
    )
    expect(stripSqlComments("SELECT '/* x */' /* real */ FROM t")).toBe("SELECT '/* x */'  FROM t")
  })
})
