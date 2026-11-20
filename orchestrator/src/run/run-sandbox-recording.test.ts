import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { recordRunSandboxSelection } from './run-sandbox-recording.ts'

test('sandbox selection records its dedicated reason while preserving the routed reason', () => {
  const id = addRun({ agent: 'grok', job: 'understand' })
  recordRunSandboxSelection(db(), id, {
    sandbox: 'host',
    reason: 'MCP was requested',
    routeReason: 'preferred route',
  })
  expect(
    db().query('SELECT sandbox,sandbox_reason,route_reason FROM run WHERE record_id=?').get(id),
  ).toEqual({
    sandbox: 'host',
    sandbox_reason: 'MCP was requested',
    route_reason: 'preferred route; sandbox host: MCP was requested',
  })
})
