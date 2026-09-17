import { expect, test } from 'bun:test'
import { createRecordSpace, recordMemberships } from '../src/record/record-space.ts'
import { proveProjectSpaceRecordSync } from './postgres-score-proof.ts'

type PsqlResult = { code: number; stdout: string; stderr: string }

export function registerProjectSpaceProofs(input: {
  actorUrl: string
  actorRole: string
  machineId: string
  userId: string
  firstSpaceId: string
  secondSpaceId: string
  otherRunId: string
  token: () => string
  setToken(token: string): void
  asSpace(user: string, password: string, spaceId: string, statement: string): PsqlResult
}): void {
  test('space creation grants ownership and duplicate slug names the existing id', async () => {
    input.setToken(input.token())
    const created = await createRecordSpace(input.actorUrl, 'DEV 741 Team', 'dev-741-team')
    expect(created.slug).toBe('dev-741-team')
    expect((await recordMemberships(input.actorUrl)).memberships).toContainEqual(
      expect.objectContaining({
        spaceId: created.id,
        slug: created.slug,
        role: 'owner',
        permission: 'write',
      }),
    )
    await expect(createRecordSpace(input.actorUrl, 'Duplicate', created.slug)).rejects.toThrow(
      `record space slug ${created.slug} already exists: ${created.id}`,
    )
  })

  test('two projects sync into separate spaces and remain tenant-confined', async () => {
    const ids = await proveProjectSpaceRecordSync({
      actorUrl: input.actorUrl,
      actorRole: input.actorRole,
      machineId: input.machineId,
      userId: input.userId,
      firstSpaceId: input.firstSpaceId,
      secondSpaceId: input.secondSpaceId,
      asSpace: input.asSpace,
    })
    expect(ids).toHaveLength(2)
  })

  test('cross-space run SELECT returns nothing', () => {
    const result = input.asSpace(
      input.actorRole,
      'actor-password',
      input.firstSpaceId,
      `SELECT id FROM run WHERE id = '${input.otherRunId}';`,
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.split('\n').at(-1)).toBe('')
  })

  test('cross-space write is refused', () => {
    const result = input.asSpace(
      input.actorRole,
      'actor-password',
      input.firstSpaceId,
      `INSERT INTO project (id, space_id, name, created_at)
       VALUES ('01990000-0000-7000-8000-00000000002b', '${input.secondSpaceId}', 'intruder', now());`,
    )
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('violates row-level security policy')
  })
}
