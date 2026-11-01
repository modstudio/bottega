import { expect, test } from 'bun:test'
import { outboxSerializationViolations } from './check-outbox-serialization.ts'

test('refuses a production outbox insert without the shared serializer', () => {
  expect(
    outboxSerializationViolations([
      {
        file: 'orchestrator/src/record/example.ts',
        source:
          "database.query('insert into outbox   (kind,payload) values (?,?)').run(kind, JSON.stringify(payload))\n",
      },
    ]),
  ).toEqual([
    'orchestrator/src/record/example.ts:1: outbox payload writes must import and call stringifyOutboxPayload before enqueue',
  ])
})

test('refuses an outbox insert that calls the serializer without sanitizing', () => {
  expect(
    outboxSerializationViolations([
      {
        file: 'orchestrator/src/run/example.ts',
        source:
          "import { serializeOutboxPayload } from '../record/outbox-serialize.ts'\nconst text = serializeOutboxPayload(kind, payload)\ndatabase.query('INSERT INTO outbox(kind,payload)').run(kind, text)\n",
      },
    ]),
  ).toEqual([
    'orchestrator/src/run/example.ts:3: outbox payload writes must import and call stringifyOutboxPayload before enqueue',
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

test('allows an outbox payload write that imports and calls the wrapper', () => {
  expect(
    outboxSerializationViolations([
      {
        file: 'orchestrator/src/run/example.ts',
        source:
          "import { stringifyOutboxPayload } from '../record/outbox-sanitize.ts'\nconst text = stringifyOutboxPayload(kind, payload)\ndatabase.query('INSERT INTO outbox(kind,payload)').run(kind, text)\n",
      },
    ]),
  ).toEqual([])
})
