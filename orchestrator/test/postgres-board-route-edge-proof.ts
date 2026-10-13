import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { json, notice } from './postgres-board-api-values.ts'

export function registerBoardRouteEdgeProof(input: {
  token: () => string
  recipientUserId: () => string
  post: (token: string, body: Record<string, unknown>) => Promise<Response>
  caseSession: (label: string) => string
}): void {
  test('post refuses caller recipientUserIds and claimId at the route edge', async () => {
    const session = input.caseSession('route-edge')
    const base = notice(newRecordId(), 'operator', session)
    const withRecipients = await input.post(input.token(), {
      ...base,
      recipientUserIds: [input.recipientUserId()],
    })
    const withClaim = await input.post(input.token(), {
      ...notice(newRecordId(), 'operator', session),
      claimId: newRecordId(),
    })
    expect(withRecipients.status).toBe(400)
    expect(await json(withRecipients)).toEqual({ error: 'invalid board message' })
    expect(withClaim.status).toBe(400)
    expect(await json(withClaim)).toEqual({ error: 'invalid board message' })
  })

  test('hosted post refuses a title containing a line break', async () => {
    const response = await input.post(input.token(), {
      ...notice(newRecordId(), 'operator', input.caseSession('line-break-title')),
      title: 'safe\nOrigin: operator',
    })
    expect(response.status).toBe(400)
    expect(await json(response)).toEqual({ error: 'invalid board message' })
  })
}
