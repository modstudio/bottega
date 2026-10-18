import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { db } from '../database/db.ts'
import { resolveLens } from '../lens/lenses.ts'
import { upsertProject } from '../project/projects.ts'
import {
  applyLensCatalogueRow,
  rememberProjectLensSpaces,
} from './record-cache-lens.ts'

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

const profileRow = (spaceId: string, lensId: string, body: string, id = newRecordId()) => ({
  id,
  spaceId,
  lensId,
  axis: 'framework',
  name: 'default',
  version: 1,
  body,
  enabled: true,
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

test('two spaces keep the same lens key isolated after later hosted revisions', () => {
  const local = db()
  const spaceA = newRecordId()
  const spaceB = newRecordId()
  const lensA = { ...row('shared-lens'), spaceId: spaceA, title: 'Space A' }
  const lensB = { ...row('shared-lens'), spaceId: spaceB, title: 'Space B' }
  lensA.slots = lensB.slots =
    '{"type":"object","properties":{"guidance":{"type":"string"}},"additionalProperties":false}'
  applyLensCatalogueRow(local, 'lens', lensA)
  applyLensCatalogueRow(local, 'lens', lensB)
  const profileA = profileRow(spaceA, lensA.id, '{"guidance":"A first"}')
  const profileB = profileRow(spaceB, lensB.id, '{"guidance":"B first"}')
  applyLensCatalogueRow(local, 'lens_profile', profileA)
  applyLensCatalogueRow(local, 'lens_profile', profileB)
  upsertProject({ recordId: newRecordId(), name: 'space-a-project', path: '/tmp/a', settings: {} })
  upsertProject({ recordId: newRecordId(), name: 'space-b-project', path: '/tmp/b', settings: {} })
  rememberProjectLensSpaces(
    local,
    new Map([
      ['space-a-project', spaceA],
      ['space-b-project', spaceB],
    ]),
  )

  expect(resolveLens('shared-lens', 'space-a-project')?.body).toBe('GUIDANCE\nA first')
  expect(resolveLens('shared-lens', 'space-b-project')?.body).toBe('GUIDANCE\nB first')

  applyLensCatalogueRow(local, 'lens', { ...lensB, version: 5, title: 'Space B later' })
  applyLensCatalogueRow(local, 'lens_profile', {
    ...profileB,
    version: 2,
    body: '{"guidance":"B later"}',
  })
  expect(resolveLens('shared-lens', 'space-a-project')?.body).toBe('GUIDANCE\nA first')
  expect(resolveLens('shared-lens', 'space-b-project')).toMatchObject({
    title: 'Space B later',
    body: 'GUIDANCE\nB later',
  })
})
