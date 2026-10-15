import { expect } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'

/** Proves client-supplied project identity and existing-name precedence in PostgreSQL. */
export async function proveProjectIdentity(
  origin: string,
  headers: Record<string, string>,
): Promise<void> {
  const suppliedId = newRecordId()
  const ignoredId = newRecordId()
  const name = `project-identity-${suppliedId}`
  const put = async (id: string) => {
    const response = await fetch(`${origin}/v1/projects`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        id,
        name,
        path: `/tmp/${name}`,
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
  expect((await put(ignoredId)).id).toBe(suppliedId)

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
    expect(response.status).toBe(200)
    return response.json() as Promise<{ id: string; name: string }>
  }
  const [left, right] = await Promise.all([racingPut(newRecordId()), racingPut(newRecordId())])
  expect(left.id).toBe(right.id)
}
