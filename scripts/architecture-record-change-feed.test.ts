import { expect, test } from 'bun:test'
import { HOSTED_RECORD_CHANGE_TABLES } from '../hub/src/hosted-record-changes.ts'
import { RECORD_CHANGE_LOG_TABLES } from '../orchestrator/src/record/record-change-feed.ts'
import {
  RECORD_CHANGE_CHILD_TABLES,
  RECORD_CHANGE_EXCLUDED_TABLES,
  RECORD_CHANGE_TRIGGER_TABLES,
} from '../shared/record/schema-record-change.ts'

const triggerTables = new Set<string>(RECORD_CHANGE_TRIGGER_TABLES)
const childTables = new Set<string>(RECORD_CHANGE_CHILD_TABLES.map(([table]) => table))
const excludedTables = new Set(Object.keys(RECORD_CHANGE_EXCLUDED_TABLES))
const feedTables = new Set<string>([...HOSTED_RECORD_CHANGE_TABLES, ...RECORD_CHANGE_LOG_TABLES])

test('every record feed table is logged and not excluded', () => {
  expect(
    [...feedTables].filter((table) => !triggerTables.has(table) || excludedTables.has(table)),
  ).toEqual([])
})

test('every logged non-child table is read by a record feed', () => {
  expect(
    [...triggerTables].filter((table) => !childTables.has(table) && !feedTables.has(table)),
  ).toEqual([])
})
