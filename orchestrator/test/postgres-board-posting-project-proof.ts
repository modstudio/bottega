import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { expiresAt, headers, json, notice } from './postgres-board-api-values.ts'

export function registerBoardPostingProjectProof(input: {
  origin: () => string
  tokenA: () => string
  tokenB: () => string
  tokenD: () => string
  post: (token: string, body: Record<string, unknown>) => Promise<Response>
  caseSession: (label: string) => string
  succeeds: (user: string, password: string, source: string) => string
  project: string
  projectTwo: string
  originProject: string
  projectId: string
  originProjectId: string
}): void {
  test('plain architects duplicate identity includes the posting project', async () => {
    const session = input.caseSession('architects-project-duplicate')
    const firstId = newRecordId()
    const secondId = newRecordId()
    const content = {
      kind: 'notice',
      audience: 'architects',
      title: 'Same architects notice',
      body: 'Same architects body.',
      expiresAt,
      authorSession: session,
    }
    const first = await input.post(input.tokenA(), {
      ...content,
      id: firstId,
      project: input.project,
    })
    const second = await input.post(input.tokenA(), {
      ...content,
      id: secondId,
      project: input.projectTwo,
    })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect((await json(first)).id).toBe(firstId)
    expect((await json(second)).id).toBe(secondId)
  })

  test('posting projects survive post and reply, stay flagged when hidden, and clear on removal', async () => {
    const rootId = newRecordId()
    const replyId = newRecordId()
    const rootResponse = await input.post(input.tokenA(), {
      ...notice(rootId, 'spaces', input.caseSession('posting-project-root')),
      project: input.originProject,
    })
    expect(rootResponse.status).toBe(200)
    const root = await json(rootResponse)
    expect((root.origin as Record<string, unknown>).project).toBe(input.originProject)
    expect((root.origin as Record<string, unknown>).projectStored).toBe(true)

    const replyResponse = await fetch(`${input.origin()}/v1/board/messages/${rootId}/replies`, {
      method: 'POST',
      headers: headers(input.tokenB()),
      body: JSON.stringify({
        id: replyId,
        body: 'Reply with its own posting project.',
        authorSession: input.caseSession('posting-project-reply'),
        project: input.project,
      }),
    })
    expect(replyResponse.status).toBe(200)
    const reply = await json(replyResponse)
    expect((reply.origin as Record<string, unknown>).project).toBe(input.project)
    expect((reply.origin as Record<string, unknown>).projectStored).toBe(true)

    const hiddenResponse = await fetch(`${input.origin()}/v1/board/threads/${rootId}`, {
      headers: headers(input.tokenD()),
    })
    expect(hiddenResponse.status).toBe(200)
    const hidden = await json(hiddenResponse)
    const hiddenOrigin = ((hidden.root as Record<string, unknown>).origin ?? {}) as Record<
      string,
      unknown
    >
    expect(hiddenOrigin.project).toBeNull()
    expect(hiddenOrigin.projectStored).toBe(true)

    expect(
      input
        .succeeds(
          'postgres',
          'postgres',
          `SELECT author_project_id FROM board_message WHERE id='${rootId}';
         SELECT author_project_id FROM board_message WHERE id='${replyId}';`,
        )
        .split('\n'),
    ).toEqual([input.originProjectId, input.projectId])
    input.succeeds(
      'postgres',
      'postgres',
      `DELETE FROM project WHERE id='${input.originProjectId}';`,
    )
    expect(
      input.succeeds(
        'postgres',
        'postgres',
        `SELECT author_project_id IS NULL FROM board_message WHERE id='${rootId}';`,
      ),
    ).toBe('t')
  })
}
