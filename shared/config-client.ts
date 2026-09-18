import { readRecordSessionToken } from './record-session.ts'

export type ConfigClientErrorReason = 'not-configured' | 'unreachable' | 'response'

export class ConfigClientError extends Error {
  readonly reason: ConfigClientErrorReason
  readonly route: string
  readonly status?: number
  constructor(reason: ConfigClientErrorReason, route: string, status?: number) {
    super(
      reason === 'not-configured'
        ? 'hosted config is not configured'
        : reason === 'unreachable'
          ? `hosted config route ${route} is unreachable`
          : `hosted config route ${route} returned HTTP ${status}`,
    )
    this.name = 'ConfigClientError'
    this.reason = reason
    this.route = route
    this.status = status
  }
}

export type ConfigScope = 'user' | 'space'
type ConfigEntry = {
  key: string
  environment: string
  scope: ConfigScope
  value: string
  rowVersion: number
  updatedAt: string
}
export type ConfigSecret = {
  key: string
  environment: string
  scope: ConfigScope
  dekId: string
  rowVersion: number
  updatedAt: string
  envelope?: string
}
type DataKeyWrap = {
  recipientKeyId: string
  senderKeyId: string
  enc: string
  ciphertext: string
}
export type DataKey = {
  id: string
  version: number
  createdAt: string
  retiredAt: string | null
  wraps: DataKeyWrap[]
}
type MachineKey = {
  keyId: string
  publicKey: string
  label: string
  createdAt: string
  revokedAt: string | null
}
type ConfigIdentity = { user: { id: string }; activeSpaceId: string | null }

export type ConfigClient = ReturnType<typeof createConfigClient>
type Transport = typeof fetch

function createConfigClient(baseUrl: string, token: string, transport: Transport) {
  const request = async <T>(route: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${token}`)
    if (init.body) headers.set('content-type', 'application/json')
    let response: Response
    try {
      response = await transport(`${baseUrl}${route}`, { ...init, headers })
    } catch {
      throw new ConfigClientError('unreachable', route)
    }
    if (!response.ok) throw new ConfigClientError('response', route, response.status)
    return (await response.json()) as T
  }
  const query = (values: Record<string, string>) => `?${new URLSearchParams(values)}`
  return {
    whoami: () => request<ConfigIdentity>('/v1/whoami'),
    listEntries: (environment = 'default') =>
      request<{ items: ConfigEntry[] }>(`/v1/config/entries${query({ environment })}`).then(
        (x) => x.items,
      ),
    getEntry: (key: string, scope: ConfigScope, environment = 'default') =>
      request<ConfigEntry>(
        `/v1/config/entries/${encodeURIComponent(key)}${query({ scope, environment })}`,
      ),
    putEntry: (
      key: string,
      input: {
        scope: ConfigScope
        environment: string
        value: string
        expectedRowVersion: number | null
      },
    ) =>
      request<ConfigEntry>(`/v1/config/entries/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    deleteEntry: (
      key: string,
      input: { scope: ConfigScope; environment: string; expectedRowVersion: number },
    ) =>
      request<{ deleted: true }>(`/v1/config/entries/${encodeURIComponent(key)}`, {
        method: 'DELETE',
        body: JSON.stringify(input),
      }),
    listSecrets: (environment = 'default') =>
      request<{ items: ConfigSecret[] }>(`/v1/config/secrets${query({ environment })}`).then(
        (x) => x.items,
      ),
    getSecret: (key: string, scope: ConfigScope, environment = 'default') =>
      request<ConfigSecret & { envelope: string }>(
        `/v1/config/secrets/${encodeURIComponent(key)}${query({ scope, environment })}`,
      ),
    putSecret: (
      key: string,
      input: {
        scope: ConfigScope
        environment: string
        dekId: string
        envelope: string
        expectedRowVersion: number | null
      },
    ) =>
      request<ConfigSecret>(`/v1/config/secrets/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    deleteSecret: (
      key: string,
      input: { scope: ConfigScope; environment: string; expectedRowVersion: number },
    ) =>
      request<{ deleted: true }>(`/v1/config/secrets/${encodeURIComponent(key)}`, {
        method: 'DELETE',
        body: JSON.stringify(input),
      }),
    currentDataKey: (recipientKeyId: string) =>
      request<DataKey>(`/v1/config/data-keys/current${query({ recipientKeyId })}`),
    getDataKey: (dekId: string, recipientKeyId: string) =>
      request<DataKey>(
        `/v1/config/data-keys/${encodeURIComponent(dekId)}${query({ recipientKeyId })}`,
      ),
    createDataKey: (input: { dekId: string; version: number; wraps: DataKeyWrap[] }) =>
      request<{ id: string; version: number }>('/v1/config/data-keys', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    addWraps: (dekId: string, wraps: DataKeyWrap[]) =>
      request<{ added: number }>(`/v1/config/data-keys/${encodeURIComponent(dekId)}/wraps`, {
        method: 'POST',
        body: JSON.stringify({ wraps }),
      }),
    retireDataKey: (dekId: string) =>
      request<{ retired: true }>(`/v1/config/data-keys/${encodeURIComponent(dekId)}/retire`, {
        method: 'POST',
      }),
    listMachineKeys: () =>
      request<{ items: MachineKey[] }>('/v1/config/machine-keys').then((x) => x.items),
    registerMachineKey: (keyId: string, publicKey: string, label: string) =>
      request<MachineKey>(`/v1/config/machine-keys/${keyId}`, {
        method: 'PUT',
        body: JSON.stringify({ publicKey, label }),
      }),
    revokeMachineKey: (keyId: string) =>
      request<{ revoked: true }>(`/v1/config/machine-keys/${keyId}/revoke`, { method: 'POST' }),
  }
}

export function configClient(
  env: Record<string, string | undefined> = process.env,
  transport: Transport = fetch,
  token?: string | null,
): ConfigClient {
  const url = env.ORCH_RECORD_API_URL
  if (!url) throw new ConfigClientError('not-configured', '/v1/config')
  const resolvedToken = token === undefined ? readRecordSessionToken() : token
  if (!resolvedToken) throw new ConfigClientError('not-configured', '/v1/config')
  return createConfigClient(url.replace(/\/$/, ''), resolvedToken, transport)
}
