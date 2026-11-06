import { expect, test } from 'bun:test'
import { detectUnsafeJsonGuards } from './check-json-valid-guards.ts'

test('finds JSON reads guarded only by AND evaluation order', () => {
  expect(
    detectUnsafeJsonGuards(
      `SELECT * FROM outbox
        WHERE json_valid(payload) AND json_extract(payload, '$.reviewId') = ?`,
    ),
  ).toHaveLength(1)
})

test('accepts JSON reads inside the matching CASE branch', () => {
  expect(
    detectUnsafeJsonGuards(
      `SELECT * FROM outbox
        WHERE CASE WHEN json_valid(payload)
          THEN json_extract(payload, '$.reviewId') = ? AND json_type(payload) = 'object'
          ELSE 0 END`,
    ),
  ).toEqual([])
})

test('does not apply the production-query rule to CHECK constraints', () => {
  expect(
    detectUnsafeJsonGuards(
      `CREATE TABLE example (
        payload TEXT CHECK (json_valid(payload) AND json_type(payload) = 'object')
      )`,
    ),
  ).toEqual([])
})

test.each(['json_each', 'json_tree'])(
  'finds a %s table read guarded only by a WHERE term',
  (functionName) => {
    expect(
      detectUnsafeJsonGuards(
        `SELECT declared.value
           FROM project, ${functionName}(project.settings) declared
          WHERE json_valid(project.settings)`,
      ),
    ).toHaveLength(1)
  },
)

test('distinguishes the original and repaired 0163 table and element guards', () => {
  expect(
    detectUnsafeJsonGuards(
      `SELECT 1
         FROM project, json_each(project.settings, '$.review.lenses') declared
        WHERE project.record_id=review.project_record_id
          AND project.settings IS NOT NULL
          AND json_valid(project.settings)
          AND json_extract(declared.value, '$.lens')='issue-blast-radius'`,
    ),
  ).not.toEqual([])
  expect(
    detectUnsafeJsonGuards(
      `SELECT 1
         FROM project,
              json_each(CASE WHEN json_valid(project.settings)
                THEN project.settings ELSE '[]' END, '$.review.lenses') declared
        WHERE project.record_id=review.project_record_id
          AND project.settings IS NOT NULL
          AND CASE WHEN declared.type='object'
            THEN json_extract(declared.value, '$.lens')='issue-blast-radius'
            ELSE 0 END`,
    ),
  ).toEqual([])
})
