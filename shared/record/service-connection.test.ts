import { expect, test } from 'bun:test'
import {
  RECORD_SERVICE_IDLE_IN_TRANSACTION_TIMEOUT,
  RECORD_SERVICE_STATEMENT_TIMEOUT,
  recordServiceUrl,
} from './service-connection.ts'

test('record service URL carries both startup transaction bounds and preserves existing options', () => {
  const configured = new URL(
    recordServiceUrl('postgres://actor:secret@record.example/record?sslmode=require&options=-c%20search_path%3Dpublic'),
  )
  expect(configured.searchParams.get('sslmode')).toBe('require')
  expect(configured.searchParams.get('options')).toBe(
    `-c search_path=public -c statement_timeout=${RECORD_SERVICE_STATEMENT_TIMEOUT} -c idle_in_transaction_session_timeout=${RECORD_SERVICE_IDLE_IN_TRANSACTION_TIMEOUT}`,
  )
})
