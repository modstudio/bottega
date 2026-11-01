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
    'orchestrator/src/record/example.ts:1: outbox inserts must import and call serializeOutboxPayload before enqueue',
  ])
})

test('allows an outbox insert that imports and calls the serializer', () => {
  expect(
    outboxSerializationViolations([
      {
        file: 'orchestrator/src/run/example.ts',
        source:
          "import { serializeOutboxPayload } from '../record/outbox-serialize.ts'\nconst text = serializeOutboxPayload(kind, payload)\ndatabase.query('INSERT INTO outbox(kind,payload)').run(kind, text)\n",
      },
    ]),
  ).toEqual([])
})
