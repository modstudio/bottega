import { expect, test } from 'bun:test'
import { outboxSerializationViolations } from './check-outbox-serialization.ts'

test('refuses a production enqueue without the shared serializer', () => {
  expect(
    outboxSerializationViolations([
      {
        file: 'orchestrator/src/record/example.ts',
        source: 'insertOutboxRow(database, { kind, payload: JSON.stringify(payload) })\n',
      },
    ]),
  ).toEqual([
    'orchestrator/src/record/example.ts:1: outbox payload writes must import and call stringifyOutboxPayload before enqueue',
  ])
})

test('refuses an enqueue that calls a serializer without sanitizing', () => {
  expect(
    outboxSerializationViolations([
      {
        file: 'orchestrator/src/run/example.ts',
        source:
          "import { serializeOutboxPayload } from '../record/outbox-serialize.ts'\nconst text = serializeOutboxPayload(kind, payload)\ninsertOutboxRow(database, { kind, payload: text })\n",
      },
    ]),
  ).toEqual([
    'orchestrator/src/run/example.ts:3: outbox payload writes must import and call stringifyOutboxPayload before enqueue',
  ])
})

test('refuses an enqueue helper call with a raw JSON payload', () => {
  expect(
    outboxSerializationViolations([
      {
        file: 'orchestrator/src/review/example.ts',
        source:
          "import { insertOutboxRow } from '../record/outbox-enqueue.ts'\ninsertOutboxRow(database, { payload: JSON.stringify(value) })\n",
      },
    ]),
  ).toEqual([
    'orchestrator/src/review/example.ts:2: outbox payload writes must import and call stringifyOutboxPayload before enqueue',
  ])
})

test('refuses an outbox payload update without the shared wrapper', () => {
  expect(
    outboxSerializationViolations([
      {
        file: 'orchestrator/src/run/example.ts',
        source: "database.query('update outbox set payload=?').run(JSON.stringify(payload))\n",
      },
    ]),
  ).toEqual([
    'orchestrator/src/run/example.ts:1: outbox payload writes must import and call stringifyOutboxPayload before enqueue',
  ])
})

test('refuses a reordered payload update and an enqueue', () => {
  expect(
    outboxSerializationViolations([
      {
        file: 'orchestrator/src/run/reordered.ts',
        source:
          "database.query('UPDATE outbox SET attempts=0, payload=? WHERE id=?').run(text, id)\n",
      },
      {
        file: 'orchestrator/src/run/values.ts',
        source: 'insertOutboxRow(database, { ...row, payload: JSON.stringify(row) })\n',
      },
    ]),
  ).toEqual([
    'orchestrator/src/run/reordered.ts:1: outbox payload writes must import and call stringifyOutboxPayload before enqueue',
    'orchestrator/src/run/values.ts:1: outbox payload writes must import and call stringifyOutboxPayload before enqueue',
  ])
})

test('ignores outbox bookkeeping updates and audit-table inserts', () => {
  expect(
    outboxSerializationViolations([
      {
        file: 'orchestrator/src/record/bookkeeping.ts',
        source:
          "database.query('UPDATE outbox SET attempts=attempts+1 WHERE id=? AND payload=?').run(id, text)\nconst payload = {}\ndatabase.query('INSERT INTO outbox_redaction_audit (record_id) VALUES (?)').run(id)\n",
      },
    ]),
  ).toEqual([])
})

test('allows an outbox payload write that imports and calls the wrapper', () => {
  expect(
    outboxSerializationViolations([
      {
        file: 'orchestrator/src/run/example.ts',
        source:
          "import { stringifyOutboxPayload } from '../record/outbox-sanitize.ts'\nconst text = stringifyOutboxPayload(kind, payload)\ninsertOutboxRow(database, { kind, payload: text })\n",
      },
    ]),
  ).toEqual([])
})

test('allows the declared delivered-payload release marker', () => {
  expect(
    outboxSerializationViolations([
      {
        file: 'orchestrator/src/record/outbox-prune.ts',
        source:
          "import { RELEASED_OUTBOX_PAYLOAD } from './outbox-prune-payload.ts'\ndatabase.query('UPDATE outbox SET payload=? WHERE id=?').run(RELEASED_OUTBOX_PAYLOAD, id)\n",
      },
    ]),
  ).toEqual([])
})
