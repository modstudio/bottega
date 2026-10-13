import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { BOARD_MESSAGE_NOTIFY_CHANNEL } from '../../shared/record/board-stream.ts'
import { newRecordId } from '../../shared/record/schema.ts'
import { bindTenant } from '../../shared/record/tenant.ts'

export function registerBoardStreamProof(input: {
  actorUrl: string
  origin: () => string
  token: () => string
  userId: () => string
  activeSpaceId: () => string
  spaceIds: () => string[]
}): void {
  test('board notification waits for commit and an invisible write does not advance the stream', async () => {
    const stream = await fetch(`${input.origin()}/v1/board/stream`, {
      headers: { authorization: `Bearer ${input.token()}` },
    })
    expect(stream.status).toBe(200)
    const reader = stream.body!.getReader()
    const initial = await reader.read()
    expect(initial.done).toBe(false)

    const listener = new SQL(input.actorUrl)
    const writer = new SQL(input.actorUrl)
    let notifications = 0
    const subscription = await listener.listen(BOARD_MESSAGE_NOTIFY_CHANNEL, () => {
      notifications++
    })
    try {
      const id = newRecordId()
      await writer.begin(async (tx) => {
        await bindTenant(tx, {
          userId: input.userId(),
          spaceId: input.activeSpaceId(),
          spaceIds: input.spaceIds(),
        })
        await tx`
          INSERT INTO board_message
            (id, author_user_id, kind, audience, title, body, ack_required, expires_at, created_at)
          VALUES
            (${id}::uuid, ${input.userId()}::uuid, 'notice', 'operator', 'stream proof', 'proof',
             false, now() + interval '1 day', now())
        `
        await Bun.sleep(100)
        expect(notifications).toBe(0)
      })
      for (let attempt = 0; attempt < 20 && notifications === 0; attempt++) await Bun.sleep(25)
      expect(notifications).toBe(1)
      const next = await Promise.race([
        reader.read().then(() => 'event'),
        Bun.sleep(300).then(() => 'silent'),
      ])
      expect(next).toBe('silent')
    } finally {
      await reader.cancel()
      await subscription.unlisten()
      await listener.close()
      await writer.close()
    }
  })
}
