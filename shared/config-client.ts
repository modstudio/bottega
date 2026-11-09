import type {
  CredentialEnvironment,
  CredentialMetadataFields,
  CredentialMode,
  CredentialPreference,
} from './credential.ts'
import { scheduleHostedCallObservation } from './hosted-call-observation.ts'
import { jsonBody } from './http-json.ts'
import { resolveRecordApiUrl } from './record-api-url.ts'
import { RECORD_SIGN_IN_REMEDY } from './record-remedies.ts'
import { readRecordSessionToken, sendWithStoredRecordSessionToken } from './record-session.ts'

export type ConfigClientErrorReason = 'not-configured' | 'unreachable' | 'response'

export class ConfigClientError extends Error {
  readonly reason: ConfigClientErrorReason
  readonly route: string
  readonly status?: number
  readonly error?: string
  readonly remedy?: string
  constructor(
    reason: ConfigClientErrorReason,
    route: string,
    status?: number,
    details?: { url?: string; contentType?: string; error?: string; remedy?: string },
  ) {
    const refusal = [details?.error, details?.remedy].filter(Boolean).join('; ')
    super(
      reason === 'not-configured'
        ? `hosted config is not configured; ${RECORD_SIGN_IN_REMEDY}`
        : reason === 'unreachable'
          ? `hosted config route ${route} is unreachable`
          : details?.url && details.contentType
            ? `hosted config refused the response from ${details.url} (status ${status}, content type ${details.contentType}): expected JSON. ${RECORD_SIGN_IN_REMEDY}`
            : `hosted config route ${route} returned HTTP ${status}${refusal ? `: ${refusal}` : ''}`,
    )
    this.name = 'ConfigClientError'
    this.reason = reason
    this.route = route
    this.status = status
    this.error = details?.error
    this.remedy = details?.remedy
  }
}

export type ConfigScope = 'user' | 'space'
export type ConfigDestination = { destinationSpaceId?: string; projectId?: string | null }
export type ConfigEntry = {
  key: string
  environment: string
  scope: ConfigScope
  value: string
  rowVersion: number
  updatedAt: string
}
export type ConfigSecret = {
  id?: string
  key: string
  environment: string
  scope: ConfigScope
  projectId?: string | null
  provider?: CredentialMetadataFields['provider'] | null
  name?: CredentialMetadataFields['name']
  type?: CredentialMetadataFields['type'] | null
  hint?: CredentialMetadataFields['hint'] | null
  mode?: CredentialMode | null
  reachSpaceIds?: string[] | null
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
type ConfigIdentity = {
  user: { id: string }
  activeSpaceId: string | null
  personalSpaceId: string | null
  memberships: Array<{ space_id: string; slug: string; permission: string }>
}

export type ConfigClient = ReturnType<typeof createConfigClient>
type Transport = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>
type ConfigRequestInit = RequestInit & ConfigDestination
type Request = <T>(route: string, init?: ConfigRequestInit) => Promise<T>
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
    createMachineKeyClaimChallenge: (keyId: string, destination: ConfigDestination = {}) =>
      request<{ challengeId: string; enc: string; ciphertext: string; senderPublicKey: string }>(
        `/v1/config/machine-keys/${keyId}/claim-challenge`,
        { ...destination, method: 'POST' },
      ),
    claimMachineKey: (
      keyId: string,
      challengeId: string,
      nonce: string,
      destination: ConfigDestination = {},
    ) =>
      request<{ claimed: true }>(`/v1/config/machine-keys/${keyId}/claim`, {
        ...destination,
        method: 'POST',
        body: JSON.stringify({ challengeId, nonce }),
      }),
    revokeMachineKey: (keyId: string, destination: ConfigDestination = {}) =>
      request<{ revoked: true }>(`/v1/config/machine-keys/${keyId}/revoke`, {
        ...destination,
        method: 'POST',
      }),
  }
}

type Query = (values: Record<string, string>) => string

function configValueClient(request: Request, query: Query) {
  return {
    listEntries: (environment = 'default', destination: ConfigDestination = {}) =>
      request<{ items: ConfigEntry[] }>(
        `/v1/config/entries${query({ environment })}`,
        destination,
      ).then((x) => x.items),
    getEntry: (
      key: string,
      scope: ConfigScope,
      environment = 'default',
      destination: ConfigDestination = {},
    ) =>
      request<ConfigEntry>(
        `/v1/config/entries/${encodeURIComponent(key)}${query({ scope, environment })}`,
        destination,
      ),
    putEntry: (
      key: string,
      input: {
        scope: ConfigScope
        environment: string
        value: string
        expectedRowVersion: number | null
      },
      destination: ConfigDestination = {},
    ) =>
      request<ConfigEntry>(`/v1/config/entries/${encodeURIComponent(key)}`, {
        ...destination,
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    deleteEntry: (
      key: string,
      input: { scope: ConfigScope; environment: string; expectedRowVersion: number },
      destination: ConfigDestination = {},
    ) =>
      request<{ deleted: true }>(`/v1/config/entries/${encodeURIComponent(key)}`, {
        ...destination,
        method: 'DELETE',
        body: JSON.stringify(input),
      }),
    listSecrets: (environment: string | null = 'default', destination: ConfigDestination = {}) =>
      request<{ items: ConfigSecret[] }>(
        environment === null ? '/v1/config/secrets' : `/v1/config/secrets${query({ environment })}`,
        destination,
      ).then((x) => x.items),
    getSecret: (
      key: string,
      scope: ConfigScope,
      environment = 'default',
      destination: ConfigDestination = {},
    ) =>
      request<ConfigSecret & { envelope: string }>(
        `/v1/config/secrets/${encodeURIComponent(key)}${query({ scope, environment, ...(destination.projectId ? { projectId: destination.projectId } : {}) })}`,
        destination,
      ),
    putSecret: (
      key: string,
      input: {
        scope: ConfigScope
        environment: CredentialEnvironment | string
        mode?: CredentialMode | null
        dekId: string
        envelope: string
        expectedRowVersion: number | null
        projectId?: string | null
        provider?: CredentialMetadataFields['provider'] | null
        name?: CredentialMetadataFields['name']
        type?: CredentialMetadataFields['type'] | null
        hint?: CredentialMetadataFields['hint'] | null
        reachSpaceIds?: string[] | null
      } & ConfigDestination,
    ) =>
      request<ConfigSecret>(`/v1/config/secrets/${encodeURIComponent(key)}`, {
        method: 'PUT',
        destinationSpaceId: input.destinationSpaceId,
        body: JSON.stringify(input),
      }),
  }
}

function configSecretDeleteClient(request: Request) {
  return {
    deleteSecret: (
      key: string,
      input: {
        scope: ConfigScope
        environment: string
        expectedRowVersion: number
      } & ConfigDestination,
    ) =>
      request<{ deleted: true }>(
        `/v1/config/secrets/${encodeURIComponent(key)}${input.projectId ? `?projectId=${encodeURIComponent(input.projectId)}` : ''}`,
        {
          method: 'DELETE',
          destinationSpaceId: input.destinationSpaceId,
          body: JSON.stringify({
            scope: input.scope,
            environment: input.environment,
            expectedRowVersion: input.expectedRowVersion,
          }),
        },
      ),
  }
}

function credentialPreferenceClient(request: Request) {
  return {
    listCredentialPreferences: (destination: ConfigDestination = {}) =>
      request<{ items: CredentialPreference[] }>(
        '/v1/config/credential-preferences',
        destination,
      ).then((x) => x.items),
    putCredentialPreference: (input: Omit<CredentialPreference, 'updatedAt'> & ConfigDestination) =>
      request<CredentialPreference>('/v1/config/credential-preferences', {
        method: 'PUT',
        destinationSpaceId: input.destinationSpaceId,
        body: JSON.stringify(input),
      }),
    deleteCredentialPreference: (
      input: Pick<
        CredentialPreference,
        'projectId' | 'provider' | 'name' | 'type' | 'mode' | 'environment'
      > &
        ConfigDestination,
    ) =>
      request<{ deleted: true }>('/v1/config/credential-preferences', {
        method: 'DELETE',
        destinationSpaceId: input.destinationSpaceId,
        body: JSON.stringify(input),
      }),
  }
}

function configKeyClient(request: Request, query: Query) {
  return {
    currentDataKey: (recipientKeyId: string, destination: ConfigDestination = {}) =>
      request<DataKey>(`/v1/config/data-keys/current${query({ recipientKeyId })}`, destination),
    listDataKeys: (destination: ConfigDestination = {}) =>
      request<{ items: DataKey[] }>('/v1/config/data-keys', destination).then((x) => x.items),
    getDataKey: (dekId: string, recipientKeyId: string, destination: ConfigDestination = {}) =>
      request<DataKey>(
        `/v1/config/data-keys/${encodeURIComponent(dekId)}${query({ recipientKeyId })}`,
        destination,
      ),
    createDataKey: (
      input: { dekId: string; version: number; wraps: DataKeyWrap[] },
      destination: ConfigDestination = {},
    ) =>
      request<{ id: string; version: number }>('/v1/config/data-keys', {
        ...destination,
        method: 'POST',
        body: JSON.stringify(input),
      }),
    addWraps: (dekId: string, wraps: DataKeyWrap[], destination: ConfigDestination = {}) =>
      request<{ added: number }>(`/v1/config/data-keys/${encodeURIComponent(dekId)}/wraps`, {
        ...destination,
        method: 'POST',
        body: JSON.stringify({ wraps }),
      }),
    retireDataKey: (dekId: string, destination: ConfigDestination = {}) =>
      request<{ retired: true }>(`/v1/config/data-keys/${encodeURIComponent(dekId)}/retire`, {
        ...destination,
        method: 'POST',
      }),
    listMachineKeys: (destination: ConfigDestination = {}) =>
      request<{ items: MachineKey[] }>('/v1/config/machine-keys', destination).then((x) => x.items),
    registerMachineKey: (
      keyId: string,
      publicKey: string,
      label: string,
      destination: ConfigDestination = {},
    ) =>
      request<MachineKey>(`/v1/config/machine-keys/${keyId}`, {
        ...destination,
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
  storedToken = false,
) {
  const request = async <T>(route: string, init: ConfigRequestInit = {}): Promise<T> => {
    const send = async (bearer: string | null) => {
      if (!bearer) throw new ConfigClientError('not-configured', route)
      const headers = new Headers(init.headers)
      headers.set('authorization', `Bearer ${bearer}`)
      if (init.destinationSpaceId) headers.set('x-record-space', init.destinationSpaceId)
      if (init.body) headers.set('content-type', 'application/json')
      const startedAt = performance.now()
      try {
        const response = await transport(`${baseUrl}${route}`, {
          ...init,
          headers,
          signal: init.signal ?? signal,
        })
        scheduleHostedCallObservation(recorder, {
          route,
          observedAt: new Date().toISOString(),
          latencyMs: performance.now() - startedAt,
          status: response.status,
          error: null,
        })
        return response
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
    }
    const response = storedToken
      ? await sendWithStoredRecordSessionToken(send, { signal: init.signal ?? signal })
      : await send(token)
    const body = await jsonBody(response, `${baseUrl}${route}`)
    if (!body.ok)
      throw new ConfigClientError('response', route, response.status, {
        url: body.url,
        contentType: body.contentType,
      })
    if (!response.ok) {
      const refusal =
        body.value && typeof body.value === 'object' && !Array.isArray(body.value)
          ? (body.value as Record<string, unknown>)
          : {}
      throw new ConfigClientError('response', route, response.status, {
        error: typeof refusal.error === 'string' ? refusal.error : undefined,
        remedy: typeof refusal.remedy === 'string' ? refusal.remedy : undefined,
      })
    }
    return body.value as T
  }
  const query = (values: Record<string, string>) => `?${new URLSearchParams(values)}`
  return {
    ...configAuthorizationClient(request),
    ...configValueClient(request, query),
    ...configSecretDeleteClient(request),
    ...credentialPreferenceClient(request),
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
  const storedToken = token === undefined
  const resolvedToken = storedToken ? readRecordSessionToken() : token
  if (!resolvedToken) throw new ConfigClientError('not-configured', '/v1/config')
  return createConfigClient(
    url.replace(/\/$/, ''),
    resolvedToken,
    transport,
    signal,
    recorder,
    storedToken,
  )
}
