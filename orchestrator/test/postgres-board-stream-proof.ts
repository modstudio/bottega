import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { newRecordId } from '../../shared/record/schema.ts'
import { bindTenant } from '../../shared/record/tenant.ts'
import { BOARD_MESSAGE_NOTIFY_CHANNEL } from '../src/record/record-board-stream.ts'
import { notice } from './postgres-board-api-values.ts'

async function waitFor(probe: () => boolean, milliseconds = 2_000): Promise<boolean> {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    if (probe()) return true
    await Bun.sleep(25)
  }
  return probe()
}

async function postVisibleNotice(input: {
  postNotice(body: Record<string, unknown>): Promise<Response>
  project: string
  projectId: string
}): Promise<string> {
  const response = await input.postNotice(
    notice(newRecordId(), `project:${input.project}`, 'board-api-stream', {
      projectId: input.projectId,
    }),
  )
  expect(response.status).toBe(200)
  return String(((await response.json()) as { revision: string }).revision)
}

export function registerBoardStreamProof(input: {
  actorUrl: string
  origin: () => string
  streamToken: () => string
  streamUserId: () => string
  writerUserId: () => string
  visibleSpaceId: () => string
  invisibleSpaceId: () => string
  writerSpaceIds: () => string[]
  streamUserHomeSpaceId: () => string
  postNotice(body: Record<string, unknown>): Promise<Response>
  project: string
  projectId: string
  admin(statement: string): string
}): void {
  test('board notification waits for commit and the production stream follows current membership', async () => {
    const membershipId = newRecordId()
    input.admin(
      `INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
       VALUES ('${membershipId}','${input.visibleSpaceId()}','${input.streamUserId()}',
         'member','write',now());`,
    )
    const select = (spaceId: string) =>
      fetch(`${input.origin()}/v1/active-space`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${input.streamToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ spaceId }),
      })
    expect((await select(input.visibleSpaceId())).status).toBe(200)

    const stream = await fetch(`${input.origin()}/v1/board/stream`, {
      headers: { authorization: `Bearer ${input.streamToken()}` },
    })
    expect(stream.status).toBe(200)
    const reader = stream.body!.getReader()
    const revisions: string[] = []
    let buffered = ''
    let ended = false
    const pumping = (async () => {
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) {
            ended = true
            return
          }
          buffered += new TextDecoder().decode(next.value)
          const frames = buffered.split('\n\n')
          buffered = frames.pop() ?? ''
          for (const frame of frames) {
            const id = frame.match(/^id: (\d+)$/m)?.[1]
            if (id) revisions.push(id)
          }
        }
      } catch {
        ended = true
      }
    })()
    expect(await waitFor(() => revisions.length === 1)).toBe(true)
    const initialRevision = revisions[0]!

    const listener = new SQL(input.actorUrl)
    const writer = new SQL(input.actorUrl)
    let notifications = 0
    const subscription = await listener.listen(BOARD_MESSAGE_NOTIFY_CHANNEL, () => {
      notifications++
    })
    try {
      let invisibleRevision = ''
      await writer.begin(async (tx) => {
        await bindTenant(tx, {
          userId: input.writerUserId(),
          spaceId: input.invisibleSpaceId(),
          spaceIds: input.writerSpaceIds(),
        })
        const rows = await tx`
          INSERT INTO board_message
            (id, author_user_id, kind, audience, title, body, ack_required, expires_at, created_at)
          VALUES
            (${newRecordId()}::uuid, ${input.writerUserId()}::uuid, 'notice', 'operator',
             'invisible stream proof', 'proof', false, now() + interval '1 day', now())
          RETURNING revision
        `
        invisibleRevision = String(rows[0]!.revision)
        await Bun.sleep(100)
        expect(notifications).toBe(0)
      })
      expect(await waitFor(() => notifications === 1)).toBe(true)
      await Bun.sleep(300)
      expect(revisions).not.toContain(invisibleRevision)

      const visibleRevision = await postVisibleNotice(input)
      expect(await waitFor(() => revisions.includes(visibleRevision))).toBe(true)
      expect(BigInt(visibleRevision)).toBeGreaterThan(BigInt(initialRevision))

      input.admin(`DELETE FROM membership WHERE id='${membershipId}';`)
      const revokedRevision = await postVisibleNotice(input)
      expect(await waitFor(() => ended)).toBe(true)
      expect(revisions).not.toContain(revokedRevision)
    } finally {
      await reader.cancel().catch(() => undefined)
      await pumping
      await subscription.unlisten()
      await listener.close()
      await writer.close()
      input.admin(`DELETE FROM membership WHERE id='${membershipId}';`)
      await select(input.streamUserHomeSpaceId())
    }
  })
}
