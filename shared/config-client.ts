import { scheduleHostedCallObservation } from './hosted-call-observation.ts'
import { jsonBody } from './http-json.ts'
import { resolveRecordApiUrl } from './record-api-url.ts'
import { RECORD_SIGN_IN_REMEDY } from './record-remedies.ts'
import { readRecordSessionToken } from './record-session.ts'

export type ConfigClientErrorReason = 'not-configured' | 'unreachable' | 'response'

export class ConfigClientError extends Error {
  readonly reason: ConfigClientErrorReason
  readonly route: string
  readonly status?: number
  constructor(
    reason: ConfigClientErrorReason,
    route: string,
    status?: number,
    details?: { url: string; contentType: string },
  ) {
    super(
      reason === 'not-configured'
        ? `hosted config is not configured; ${RECORD_SIGN_IN_REMEDY}`
        : reason === 'unreachable'
          ? `hosted config route ${route} is unreachable`
          : details
            ? `hosted config refused the response from ${details.url} (status ${status}, content type ${details.contentType}): expected JSON. ${RECORD_SIGN_IN_REMEDY}`
            : `hosted config route ${route} returned HTTP ${status}`,
    )
    this.name = 'ConfigClientError'
    this.reason = reason
    this.route = route
    this.status = status
  }
}

export type ConfigScope = 'user' | 'space'
export type ConfigEntry = {
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
  userId: string | null
}
type ConfigIdentity = { user: { id: string }; activeSpaceId: string | null }

export type ConfigClient = ReturnType<typeof createConfigClient>
type Transport = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>
type Request = <T>(route: string, init?: RequestInit) => Promise<T>
export type ConfigCallObservation = {
  route: string
  observedAt: string
  latencyMs: number
  status: number | null
  error: unknown | null
}
export type ConfigCallOutcomeRecorder = (observation: ConfigCallObservation) => void | Promise<void>

function configAuthorizationClient(request: Request) {
  return {
    createMachineKeyClaimChallenge: (keyId: string) =>
      request<{ challengeId: string; enc: string; ciphertext: string; senderPublicKey: string }>(
        `/v1/config/machine-keys/${keyId}/claim-challenge`,
        { method: 'POST' },
      ),
    claimMachineKey: (keyId: string, challengeId: string, nonce: string) =>
      request<{ claimed: true }>(`/v1/config/machine-keys/${keyId}/claim`, {
        method: 'POST',
        body: JSON.stringify({ challengeId, nonce }),
      }),
    revokeMachineKey: (keyId: string) =>
      request<{ revoked: true }>(`/v1/config/machine-keys/${keyId}/revoke`, {
        method: 'POST',
      }),
  }
}

type Query = (values: Record<string, string>) => string

function configValueClient(request: Request, query: Query) {
  return {
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
  }
}

function configKeyClient(request: Request, query: Query) {
  return {
    currentDataKey: (recipientKeyId: string) =>
      request<DataKey>(`/v1/config/data-keys/current${query({ recipientKeyId })}`),
    listDataKeys: () => request<{ items: DataKey[] }>('/v1/config/data-keys').then((x) => x.items),
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
  }
}

function createConfigClient(
  baseUrl: string,
  token: string,
  transport: Transport,
  signal?: AbortSignal,
  recorder?: ConfigCallOutcomeRecorder,
) {
  const request = async <T>(route: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${token}`)
    if (init.body) headers.set('content-type', 'application/json')
    let response: Response
    const startedAt = performance.now()
    try {
      response = await transport(`${baseUrl}${route}`, {
        ...init,
        headers,
        signal: init.signal ?? signal,
      })
    } catch (error) {
      scheduleHostedCallObservation(recorder, {
        route,
        observedAt: new Date().toISOString(),
        latencyMs: performance.now() - startedAt,
        status: null,
        error,
      })
      if (signal?.aborted) throw signal.reason
      throw new ConfigClientError('unreachable', route)
    }
    scheduleHostedCallObservation(recorder, {
      route,
      observedAt: new Date().toISOString(),
      latencyMs: performance.now() - startedAt,
      status: response.status,
      error: null,
    })
    const body = await jsonBody(response, `${baseUrl}${route}`)
    if (!body.ok)
      throw new ConfigClientError('response', route, response.status, {
        url: body.url,
        contentType: body.contentType,
      })
    if (!response.ok) throw new ConfigClientError('response', route, response.status)
    return body.value as T
  }
  const query = (values: Record<string, string>) => `?${new URLSearchParams(values)}`
  return {
    ...configAuthorizationClient(request),
    ...configValueClient(request, query),
    ...configKeyClient(request, query),
    whoami: () => request<ConfigIdentity>('/v1/whoami'),
  }
}

export function configClient(
  env: Record<string, string | undefined> = process.env,
  transport: Transport = fetch,
  token?: string | null,
  signal?: AbortSignal,
  recorder?: ConfigCallOutcomeRecorder,
): ConfigClient {
  const url = resolveRecordApiUrl(env)
  const resolvedToken = token === undefined ? readRecordSessionToken() : token
  if (!resolvedToken) throw new ConfigClientError('not-configured', '/v1/config')
  return createConfigClient(url.replace(/\/$/, ''), resolvedToken, transport, signal, recorder)
}
