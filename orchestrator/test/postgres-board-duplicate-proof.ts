import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { expiresAt, json } from './postgres-board-api-values.ts'

export function registerBoardDuplicateProof(input: {
  origin: () => string
  headers: () => Record<string, string>
  post: (body: Record<string, unknown>) => Promise<Response>
  caseSession: (label: string) => string
  succeeds: (user: string, password: string, source: string) => string
  userId: () => string
  project: string
  projectId: string
}): void {
  test('post is idempotent by id and refuses the same id with different content', async () => {
    const id = newRecordId()
    const body = {
      id,
      kind: 'notice',
      audience: `project:${input.project}`,
      projectId: input.projectId,
      title: 'Idempotent hosted post',
      body: 'Idempotent body.',
      expiresAt,
      authorSession: input.caseSession('idempotent'),
    }
    const first = await input.post(body)
    const again = await input.post(body)
    const different = await input.post({ ...body, body: 'other' })
    expect(first.status).toBe(200)
    expect(again.status).toBe(200)
    expect(await json(again)).toMatchObject({ id, duplicateOf: null })
    expect(different.status).toBe(409)
  })

  test('hosted duplicates match only live visible messages and identify the match', async () => {
    const content = {
      kind: 'notice',
      audience: 'operator',
      title: 'Duplicate liveness',
      body: 'The same hosted board content.',
      expiresAt,
      authorSession: input.caseSession('live-duplicate'),
    }
    const firstId = newRecordId()
    expect((await input.post({ ...content, id: firstId })).status).toBe(200)
    const duplicate = await input.post({ ...content, id: newRecordId() })
    expect(duplicate.status).toBe(200)
    expect(await json(duplicate)).toMatchObject({ id: firstId, duplicateOf: firstId })

    input.succeeds(
      'postgres',
      'postgres',
      `UPDATE board_message SET withdrawn_at=now(),withdrawn_reason='author' WHERE id='${firstId}';`,
    )
    const afterWithdrawId = newRecordId()
    const afterWithdraw = await input.post({ ...content, id: afterWithdrawId })
    expect(afterWithdraw.status).toBe(200)
    expect(await json(afterWithdraw)).toMatchObject({ id: afterWithdrawId, duplicateOf: null })

    input.succeeds(
      'postgres',
      'postgres',
      `UPDATE board_message SET hidden_at=now(),hidden_by_user_id='${input.userId()}',hidden_reason='duplicate' WHERE id='${afterWithdrawId}';`,
    )
    const afterHiddenId = newRecordId()
    const afterHidden = await input.post({ ...content, id: afterHiddenId })
    expect(afterHidden.status).toBe(200)
    expect(await json(afterHidden)).toMatchObject({ id: afterHiddenId, duplicateOf: null })
  })

  test('a reply identical to a withdrawn reply posts anew', async () => {
    const questionId = newRecordId()
    const asked = await input.post({
      id: questionId,
      kind: 'question',
      audience: `project:${input.project}`,
      projectId: input.projectId,
      title: 'Reply duplicate liveness',
      body: 'Can this answer be repeated?',
      expiresAt,
      authorSession: input.caseSession('reply-duplicate-root'),
    })
    expect(asked.status).toBe(200)
    const reply = (id: string) =>
      fetch(`${input.origin()}/v1/board/messages/${questionId}/replies`, {
        method: 'POST',
        headers: input.headers(),
        body: JSON.stringify({
          id,
          body: 'Repeatable answer.',
          authorSession: input.caseSession('reply-duplicate-author'),
        }),
      })
    const firstId = newRecordId()
    expect((await reply(firstId)).status).toBe(200)
    input.succeeds(
      'postgres',
      'postgres',
      `UPDATE board_message SET withdrawn_at=now(),withdrawn_reason='author' WHERE id='${firstId}';`,
    )
    const repostedId = newRecordId()
    const reposted = await reply(repostedId)
    expect(reposted.status).toBe(200)
    expect(await json(reposted)).toMatchObject({ id: repostedId, duplicateOf: null })
  })
}
