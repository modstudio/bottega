import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { db } from '../database/db.ts'
import { applyLensCatalogueRow } from './record-cache.ts'

const row = (key: string, id = newRecordId()) => ({
  id,
  spaceId: newRecordId(),
  key,
  title: `Hosted ${key}`,
  question: 'Hosted question?',
  excludes: 'Other concerns.',
  slots: '{"type":"object","properties":{},"additionalProperties":false}',
  version: 4,
  enabled: true,
  requiresExecution: false,
  updatedAt: new Date().toISOString(),
})

test('lens cache reconciles by record id, natural key, insert, and seeded key', () => {
  const local = db()
  const byId = row('hosted-by-id')
  local
    .query(
      "INSERT INTO lens (record_id,id,title,question,excludes,slots,version,enabled,requires_execution) VALUES (?,'old-key','Old','Q','E','{\"type\":\"object\",\"properties\":{},\"additionalProperties\":false}',1,1,0)",
    )
    .run(byId.id)
  applyLensCatalogueRow(local, 'lens', byId)
  expect(local.query("SELECT title FROM lens WHERE id='old-key'").get()).toEqual({
    title: 'Hosted hosted-by-id',
  })

  const natural = row('natural-key')
  local
    .query(
      "INSERT INTO lens (record_id,id,title,question,excludes,slots,version,enabled,requires_execution) VALUES (?,'natural-key','Old','Q','E','{\"type\":\"object\",\"properties\":{},\"additionalProperties\":false}',1,1,0)",
    )
    .run(newRecordId())
  applyLensCatalogueRow(local, 'lens', natural)
  expect(local.query("SELECT record_id FROM lens WHERE id='natural-key'").get()).toEqual({
    record_id: natural.id,
  })

  const inserted = row('inserted-key')
  applyLensCatalogueRow(local, 'lens', inserted)
  expect(local.query("SELECT record_id FROM lens WHERE id='inserted-key'").get()).toEqual({
    record_id: inserted.id,
  })

  const seeded = row('correctness')
  applyLensCatalogueRow(local, 'lens', seeded)
  expect(local.query("SELECT COUNT(*) AS n FROM lens WHERE id='correctness'").get()).toEqual({
    n: 1,
  })
  expect(local.query("SELECT record_id FROM lens WHERE id='correctness'").get()).toEqual({
    record_id: seeded.id,
  })
})
