import { expect } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'

/** Proves client-supplied project identity, rename-by-id, and name collision refusal. */
export async function proveProjectIdentity(
  origin: string,
  headers: Record<string, string>,
): Promise<void> {
  const suppliedId = newRecordId()
  const ignoredId = newRecordId()
  const name = `project-identity-${suppliedId}`
  const put = async (id: string, projectName = name) => {
    const response = await fetch(`${origin}/v1/projects`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        id,
        name: projectName,
        path: `/tmp/${projectName}`,
        stack: null,
        canon: false,
        settings: {},
        retiredAt: null,
      }),
    })
    expect(response.status).toBe(200)
    return response.json() as Promise<{ id: string; name: string }>
  }
  expect((await put(suppliedId)).id).toBe(suppliedId)
  const renamed = `${name}-renamed`
  expect(await put(suppliedId, renamed)).toEqual(
    expect.objectContaining({ id: suppliedId, name: renamed }),
  )
  const collision = await fetch(`${origin}/v1/projects`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      id: ignoredId,
      name: renamed,
      path: `/tmp/${renamed}`,
      stack: null,
      canon: false,
      settings: {},
      retiredAt: null,
    }),
  })
  expect(collision.status).toBe(409)

  const racingName = `project-identity-race-${suppliedId}`
  const racingPut = async (id: string) => {
    const response = await fetch(`${origin}/v1/projects`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        id,
        name: racingName,
        path: `/tmp/${racingName}`,
        stack: null,
        canon: false,
        settings: {},
        retiredAt: null,
      }),
    })
    return response
  }
  const [left, right] = await Promise.all([racingPut(newRecordId()), racingPut(newRecordId())])
  expect([left.status, right.status].sort()).toEqual([200, 409])
}
