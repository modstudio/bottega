import { expect } from 'bun:test'
import type { recordApi } from '../../src/record/record-api.ts'

type TestApp = Pick<ReturnType<typeof recordApi>, 'request'>

export async function proveCredentialRouteProjectAddressing(
  appWith: (overrides: Record<string, unknown>) => TestApp,
  projectId: string,
): Promise<void> {
  const base = {
    id: '01990000-0000-7000-8000-000000000010',
    key: 'OPENROUTER_API_KEY',
    environment: 'default',
    scope: 'user' as const,
    provider: 'openrouter',
    type: 'api-key',
    hint: 'open…test',
    dekId: '01990000-0000-7000-8000-000000000011',
    rowVersion: 1,
    updatedAt: '2026-11-08T12:00:00.000Z',
  }
  let spacePresent = true
  let projectPresent = true
  const getConfigSecret = async (input: { projectId?: string }) => {
    const isProject = input.projectId === projectId
    if ((isProject && !projectPresent) || (!isProject && !spacePresent)) return null
    return {
      ...base,
      id: isProject ? base.id : '01990000-0000-7000-8000-000000000012',
      projectId: isProject ? projectId : null,
      envelope: Uint8Array.of(isProject ? 2 : 1),
    }
  }
  const deleteConfigSecret = async (input: { projectId?: string }) => {
    if (input.projectId === projectId) projectPresent = false
    else spacePresent = false
  }
  const app = appWith({ getConfigSecret, deleteConfigSecret })
  const query = `environment=default&scope=user&projectId=${projectId}`
  const projectRead = await app.request(`/v1/config/secrets/${base.key}?${query}`)
  expect(projectRead.status).toBe(200)
  expect(await projectRead.json()).toMatchObject({ projectId, envelope: 'Ag' })

  const body = JSON.stringify({ environment: 'default', scope: 'user', expectedRowVersion: 1 })
  expect(
    (
      await app.request(`/v1/config/secrets/${base.key}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body,
      })
    ).status,
  ).toBe(200)
  expect({ spacePresent, projectPresent }).toEqual({ spacePresent: false, projectPresent: true })

  expect(
    (
      await app.request(`/v1/config/secrets/${base.key}?projectId=${projectId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body,
      })
    ).status,
  ).toBe(200)
  expect(projectPresent).toBe(false)
}
