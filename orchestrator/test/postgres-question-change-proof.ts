import { expect, test } from 'bun:test'
import {
  decodeRecordChangeCursor,
  encodeRecordChangeCursor,
  MAX_RECORD_CHANGE_PAGE_SIZE,
  type RecordChangeCursor,
} from '../../shared/record/record-changes.ts'
import { newRecordId } from '../../shared/record-id.ts'
import { recordApiClient } from '../src/record/record-api-client.ts'
import { parseRulingPageCursor } from '../src/record/record-cursor.ts'
import { QUESTION_RULINGS_PAGE_SIZE } from '../src/record/record-question-contract.ts'

type PsqlResult = { code: number; stdout: string; stderr: string }

export function registerQuestionChangeFeedProof(
  input: () => {
    actorRole: string
    spaceId: string
    projectId: string
    machineId: string
    signIn: () => void
    asSpace: (user: string, password: string, spaceId: string, statement: string) => PsqlResult
    admin: (statement: string) => string
  },
): void {
  test('question answers advance hosted rulings through the record change feed', async () => {
    const fixture = input()
    const priorQuestionId = newRecordId()
    const questionId = newRecordId()
    // A bootstrap names since because unbounded ruling history reads are refused.
    const bootstrapSince = '2026-11-15T00:00:00.000Z'
    const priorAskedAt = '2026-11-15T12:00:00.000Z'
    const priorAnsweredAt = '2026-11-15T12:01:00.000Z'
    const askedAt = '2026-11-15T13:00:00.000Z'
    const answeredAt = '2026-11-15T13:01:00.000Z'
    const priorAnsweredText = '2026-11-15 12:01:00+00'
    const answeredText = '2026-11-15 13:01:00+00'
    fixture.signIn()
    const client = recordApiClient()
    const destination = { destinationSpaceId: fixture.spaceId }

    const priorInsert = fixture.asSpace(
      fixture.actorRole,
      'actor-password',
      fixture.spaceId,
      `INSERT INTO question (
        id,number,space_id,project_id,machine_id,revision,asked_at,question,asked_via,
        withheld_fields,created_at,updated_at
      ) VALUES (
        '${priorQuestionId}',92000,'${fixture.spaceId}','${fixture.projectId}','${fixture.machineId}',1,
        '${priorAskedAt}','Does bootstrap retain existing rulings?','workflow','[]'::jsonb,
        '${priorAskedAt}','${priorAskedAt}'
      );`,
    )
    expect(priorInsert.code, priorInsert.stderr).toBe(0)
    const priorAnswer = fixture.asSpace(
      fixture.actorRole,
      'actor-password',
      fixture.spaceId,
      `UPDATE question SET revision=2,answer='Yes',answered_at='${priorAnsweredAt}',updated_at='${priorAnsweredAt}'
       WHERE id='${priorQuestionId}';`,
    )
    expect(priorAnswer.code, priorAnswer.stderr).toBe(0)
    fixture.admin(`UPDATE record_change_horizon SET (xid,seq)=(
      SELECT xid,seq FROM record_change ORDER BY xid DESC,seq DESC LIMIT 1
    ) WHERE singleton;`)

    const bootstrap = await client.readQuestions!(
      { read: 'rulings', kind: 'all', since: bootstrapSince },
      destination,
    )
    expect(bootstrap.items).toContainEqual(
      expect.objectContaining({
        record_id: priorQuestionId,
        answer: 'Yes',
        answered_at: priorAnsweredText,
      }),
    )
    expect(bootstrap.cursor).toBeString()
    expect(bootstrap.reset).toBe(false)

    const insert = fixture.asSpace(
      fixture.actorRole,
      'actor-password',
      fixture.spaceId,
      `INSERT INTO question (
        id,number,space_id,project_id,machine_id,revision,asked_at,question,asked_via,
        withheld_fields,created_at,updated_at
      ) VALUES (
        '${questionId}',92001,'${fixture.spaceId}','${fixture.projectId}','${fixture.machineId}',1,
        '${askedAt}','Does the hosted feed carry this ruling?','workflow','[]'::jsonb,
        '${askedAt}','${askedAt}'
      );`,
    )
    expect(insert.code, insert.stderr).toBe(0)

    const unanswered = await client.readQuestions!(
      { read: 'rulings', kind: 'all', changedAfter: bootstrap.cursor! },
      destination,
    )
    expect(unanswered.items).toContainEqual(
      expect.objectContaining({ record_id: questionId, answered_at: null }),
    )

    const answer = fixture.asSpace(
      fixture.actorRole,
      'actor-password',
      fixture.spaceId,
      `UPDATE question SET revision=2,answer='Yes',answered_at='${answeredAt}',updated_at='${answeredAt}'
       WHERE id='${questionId}';`,
    )
    expect(answer.code, answer.stderr).toBe(0)
    const truncated = await client.readQuestions!(
      { read: 'rulings', kind: 'all', limit: 1 },
      destination,
    )
    expect(truncated.items).toHaveLength(1)
    expect(truncated.cursor).toMatch(/^page:\d+:[^:]+$/)
    const truncatedCursor = parseRulingPageCursor(truncated.cursor!)
    expect(truncatedCursor.questionNumber).toBe(Number(truncated.items[0]!.number))
    const [capturedXid, capturedSeq] = fixture
      .admin(`SELECT xid::text || '|' || seq::text FROM record_change
        WHERE xid<pg_snapshot_xmin(pg_current_snapshot()) AND table_name='question'
        ORDER BY xid DESC,seq DESC LIMIT 1;`)
      .split('|')
    const capturedHead = { xid: BigInt(capturedXid!), seq: BigInt(capturedSeq!) }
    expect(truncatedCursor.changeHead).toEqual(capturedHead)
    expect(truncated.more).toBe(true)
    expect(truncated.reset).toBeUndefined()
    const complete = await client.readQuestions!(
      { read: 'rulings', kind: 'all', since: bootstrapSince },
      destination,
    )
    expect(complete.cursor).toBeString()

    const changed = await client.readQuestions!(
      { read: 'rulings', kind: 'all', changedAfter: bootstrap.cursor! },
      destination,
    )
    expect(changed.items).toEqual([
      expect.objectContaining({ record_id: questionId, answer: 'Yes', answered_at: answeredText }),
    ])
    expect(changed.cursor).toBeString()
    expect(changed.cursor).not.toBe(bootstrap.cursor)
    expect(changed).toMatchObject({ more: false, reset: false })
    const unchanged = await client.readQuestions!(
      { read: 'rulings', kind: 'all', changedAfter: changed.cursor! },
      destination,
    )
    expect(unchanged).toEqual({
      items: [],
      cursor: changed.cursor,
      more: false,
      reset: false,
    })

    const changedDuringDrain = fixture.asSpace(
      fixture.actorRole,
      'actor-password',
      fixture.spaceId,
      `UPDATE question SET revision=3,answer='Changed during drain',updated_at='2026-11-15T13:02:00.000Z'
       WHERE id='${priorQuestionId}';`,
    )
    expect(changedDuringDrain.code, changedDuringDrain.stderr).toBe(0)
    const nextPage = await client.readQuestions!(
      { read: 'rulings', kind: 'all', changedAfter: truncated.cursor! },
      destination,
    )
    expect(nextPage.items.length).toBeGreaterThan(0)
    expect(nextPage.items.map((item) => item.record_id)).not.toContain(
      truncated.items[0]!.record_id,
    )
    expect(nextPage.cursor).toBe(encodeRecordChangeCursor(capturedHead))
    const replayedDrainChange = await client.readQuestions!(
      { read: 'rulings', kind: 'all', changedAfter: nextPage.cursor! },
      destination,
    )
    expect(replayedDrainChange.items).toContainEqual(
      expect.objectContaining({ record_id: priorQuestionId, answer: 'Changed during drain' }),
    )

    const [horizonXid, horizonSeq] = fixture
      .admin(`SELECT xid::text || '|' || seq::text FROM record_change_horizon WHERE singleton;`)
      .split('|')
    const horizon = { xid: BigInt(horizonXid!), seq: BigInt(horizonSeq!) }
    const beforeHorizon: RecordChangeCursor =
      horizon.xid > 0n
        ? { xid: horizon.xid - 1n, seq: horizon.seq }
        : { xid: horizon.xid, seq: horizon.seq - 1n }
    const reset = await client.readQuestions!(
      {
        read: 'rulings',
        kind: 'all',
        changedAfter: encodeRecordChangeCursor(beforeHorizon),
      },
      destination,
    )
    expect(reset.reset).toBe(true)
    expect(reset.items.length).toBeLessThanOrEqual(QUESTION_RULINGS_PAGE_SIZE)
    const resetHead = reset.cursor!.startsWith('page:')
      ? parseRulingPageCursor(reset.cursor!).changeHead
      : decodeRecordChangeCursor(reset.cursor!)
    expect(resetHead).toBeDefined()
    expect(resetHead!.xid > horizon.xid || resetHead!.seq > horizon.seq).toBe(true)
    expect(
      fixture.admin(
        `SELECT count(*) FROM record_change WHERE table_name='question' AND row_id='${questionId}';`,
      ),
    ).toBe('2')

    const pagingBootstrap = await client.readQuestions!(
      { read: 'rulings', kind: 'all', since: bootstrapSince },
      destination,
    )
    expect(pagingBootstrap.cursor).toBeString()
    const pagedQuestionIds = Array.from(
      { length: MAX_RECORD_CHANGE_PAGE_SIZE + 1 },
      (_, index) => `23470000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    )
    const pagedInsert = fixture.asSpace(
      fixture.actorRole,
      'actor-password',
      fixture.spaceId,
      `WITH page_limit(last_page) AS (VALUES (${MAX_RECORD_CHANGE_PAGE_SIZE}::int))
      INSERT INTO question (
        id,number,space_id,project_id,machine_id,revision,asked_at,question,asked_via,
        answer,answered_at,withheld_fields,created_at,updated_at
      ) SELECT
        ('23470000-0000-4000-8000-' || lpad(page::text,12,'0'))::uuid,
        93000+page,'${fixture.spaceId}','${fixture.projectId}','${fixture.machineId}',1,
        '2026-11-15T14:00:00.000Z','Paging proof ' || page,'workflow','Yes',
        '2026-11-15T14:01:00.000Z','[]'::jsonb,'2026-11-15T14:00:00.000Z',
        '2026-11-15T14:01:00.000Z'
      FROM page_limit CROSS JOIN LATERAL generate_series(0,last_page) AS pages(page);`,
    )
    expect(pagedInsert.code, pagedInsert.stderr).toBe(0)

    const pagedIds = new Set<string>()
    let page = await client.readQuestions!(
      { read: 'rulings', kind: 'all', changedAfter: pagingBootstrap.cursor! },
      destination,
    )
    expect(page.more).toBe(true)
    expect(page.items.length).toBeGreaterThan(0)
    while (true) {
      for (const item of page.items) pagedIds.add(item.record_id as string)
      if (!page.more) break
      page = await client.readQuestions!(
        { read: 'rulings', kind: 'all', changedAfter: page.cursor! },
        destination,
      )
    }
    expect(pagedQuestionIds.every((id) => pagedIds.has(id))).toBe(true)

    const drainedBootstrap = await client.readQuestions!(
      { read: 'rulings', kind: 'all', since: bootstrapSince },
      destination,
    )
    const drainedIds = new Set(drainedBootstrap.items.map((item) => item.record_id as string))
    expect(pagedQuestionIds.every((id) => drainedIds.has(id))).toBe(true)
    expect(drainedBootstrap.cursor).toBeString()
    const drained = await client.readQuestions!(
      { read: 'rulings', kind: 'all', changedAfter: drainedBootstrap.cursor! },
      destination,
    )
    expect(drained.items).toEqual([])
    expect(drained.more).toBe(false)
  })
}
