import { expect, test } from 'bun:test'
import {
  type ConfigCallObservation,
  type ConfigClient,
  ConfigClientError,
  configClient,
} from './config-client.ts'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from './config-directory.ts'

test('missing URL or session is a typed not-configured error', () => {
  expect(() =>
    configClient(
      {
        [CONFIG_HOME_ENV]: '/definitely-missing-config',
        [HARNESS_ENV_FILE_ENV]: '',
      },
      fetch,
      null,
    ),
  ).toThrow(ConfigClientError)
  expect(() =>
    configClient({ BOTTEGA_RECORD_API_URL: 'https://record.test' }, fetch, null),
  ).toThrow('hosted config is not configured')
})

test('config client names an unreachable route and response status without exposing bodies', async () => {
  const unreachable = configClient(
    { BOTTEGA_RECORD_API_URL: 'https://record.test' },
    async () => {
      throw new Error('secret body')
    },
    'test',
  )
  await expect(unreachable.listSecrets()).rejects.toMatchObject({
    reason: 'unreachable',
    route: '/v1/config/secrets?environment=default',
  })
  const refused = configClient(
    { BOTTEGA_RECORD_API_URL: 'https://record.test' },
    async () => new Response('secret body', { status: 403 }),
    'test',
  )
  let error: unknown
  try {
    await refused.listSecrets()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(ConfigClientError)
  expect(error).toMatchObject({ reason: 'response', status: 403 })
  expect((error as Error).message).not.toContain('secret body')
})

test('config client preserves a JSON refusal error and remedy', async () => {
  const client = configClient(
    { BOTTEGA_RECORD_API_URL: 'https://record.test' },
    async () =>
      Response.json(
        { error: 'signed-in user lacks config access', remedy: 'ask a space owner to grant it' },
        { status: 422 },
      ),
    'test',
  )
  const refusal = client.listSecrets()
  await expect(refusal).rejects.toThrow(
    'signed-in user lacks config access; ask a space owner to grant it',
  )
  await expect(refusal).rejects.toMatchObject({
    error: 'signed-in user lacks config access',
    remedy: 'ask a space owner to grant it',
  })
})

test('config client refuses a non-JSON response with its source and response facts', async () => {
  const client = configClient(
    { BOTTEGA_RECORD_API_URL: 'https://record.test' },
    async () =>
      new Response('<html>app</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    'test',
  )
  await expect(client.whoami()).rejects.toThrow(
    'hosted config refused the response from https://record.test/v1/whoami (status 200, content type text/html)',
  )
})

test('response diagnostics remove URL credentials, queries, and fragments', async () => {
  const errors: string[] = []
  for (const url of [
    'https://username:password@record.test',
    'https://record.test?token=query-secret#fragment-secret',
  ]) {
    const client = configClient(
      { BOTTEGA_RECORD_API_URL: url },
      async () => new Response('html', { headers: { 'content-type': 'text/html' } }),
      'test',
    )
    try {
      await client.whoami()
    } catch (error) {
      errors.push((error as Error).message)
    }
  }
  expect(errors).toHaveLength(2)
  expect(errors.every((message) => message.includes('https://record.test/'))).toBe(true)
  for (const secret of ['username', 'password', 'query-secret', 'fragment-secret'])
    expect(errors.join('\n')).not.toContain(secret)
})

test('every space-scoped config client call sends its destination header', async () => {
  const authorization = [
    'createMachineKeyClaimChallenge',
    'claimMachineKey',
    'revokeMachineKey',
  ] as const satisfies readonly (keyof ConfigClient)[]
  const values = [
    'listEntries',
    'getEntry',
    'putEntry',
    'deleteEntry',
    'listSecrets',
    'getSecret',
    'putSecret',
    'deleteSecret',
  ] as const satisfies readonly (keyof ConfigClient)[]
  const preferences = [
    'listCredentialPreferences',
    'putCredentialPreference',
    'deleteCredentialPreference',
  ] as const satisfies readonly (keyof ConfigClient)[]
  const keys = [
    'currentDataKey',
    'listDataKeys',
    'getDataKey',
    'createDataKey',
    'addWraps',
    'retireDataKey',
    'listMachineKeys',
    'registerMachineKey',
  ] as const satisfies readonly (keyof ConfigClient)[]
  // whoami is the only exemption because identity is not scoped to one space.
  const exempt = ['whoami'] as const satisfies readonly (keyof ConfigClient)[]
  const headers: string[] = []
  const client = configClient(
    { BOTTEGA_RECORD_API_URL: 'https://record.test' },
    async (_input, init) => {
      headers.push(new Headers(init?.headers).get('x-record-space') ?? '')
      return Response.json({ items: [], wraps: [] })
    },
    'test',
  )
  const destination = { destinationSpaceId: 'space-destination' }
  const entry = {
    scope: 'user' as const,
    environment: 'default',
    value: 'value',
    expectedRowVersion: null,
  }
  const deleteInput = { scope: 'user' as const, environment: 'default', expectedRowVersion: 1 }
  const preference = {
    projectId: null,
    provider: 'provider',
    name: null,
    type: 'api-key',
    mode: 'default' as const,
    environment: 'local' as const,
    payer: 'personal' as const,
    binding: 'space' as const,
  }
  await Promise.all([
    client.createMachineKeyClaimChallenge('key', destination),
    client.claimMachineKey('key', 'challenge', 'nonce', destination),
    client.revokeMachineKey('key', destination),
    client.listEntries('default', destination),
    client.getEntry('key', 'user', 'default', destination),
    client.putEntry('key', entry, destination),
    client.deleteEntry('key', deleteInput, destination),
    client.listSecrets('default', destination),
    client.getSecret('key', 'user', 'default', destination),
    client.putSecret('key', { ...entry, dekId: 'dek', envelope: 'envelope', ...destination }),
    client.deleteSecret('key', { ...deleteInput, ...destination }),
    client.listCredentialPreferences(destination),
    client.putCredentialPreference({ ...preference, ...destination }),
    client.deleteCredentialPreference({ ...preference, ...destination }),
    client.currentDataKey('key', destination),
    client.listDataKeys(destination),
    client.getDataKey('dek', 'key', destination),
    client.createDataKey({ dekId: 'dek', version: 1, wraps: [] }, destination),
    client.addWraps('dek', [], destination),
    client.retireDataKey('dek', destination),
    client.listMachineKeys(destination),
    client.registerMachineKey('key', 'public', 'label', destination),
  ])
  expect(Object.keys(client).sort()).toEqual(
    [...authorization, ...values, ...preferences, ...keys, ...exempt].sort(),
  )
  expect(headers).toHaveLength(
    authorization.length + values.length + preferences.length + keys.length,
  )
  expect(headers.every((header) => header === destination.destinationSpaceId)).toBe(true)
})

test('a throwing outcome recorder does not fail the hosted config call', async () => {
  let observation: ConfigCallObservation | undefined
  let recorderInvoked!: () => void
  const invoked = new Promise<void>((resolve) => {
    recorderInvoked = resolve
  })
  const client = configClient(
    { BOTTEGA_RECORD_API_URL: 'https://record.test' },
    async () =>
      Response.json({
        user: { id: 'user' },
        activeSpaceId: null,
        personalSpaceId: null,
        memberships: [],
      }),
    'test',
    undefined,
    (received) => {
      observation = received
      recorderInvoked()
      throw new Error('fixture recording failure')
    },
  )
  await expect(client.whoami()).resolves.toEqual({
    user: { id: 'user' },
    activeSpaceId: null,
    personalSpaceId: null,
    memberships: [],
  })
  await invoked
  expect(observation).toMatchObject({ route: '/v1/whoami', status: 200, error: null })
})

test('config client records a failed transport observation', async () => {
  let observationRecorded!: (observation: ConfigCallObservation) => void
  const observation = new Promise<ConfigCallObservation>((resolve) => {
    observationRecorded = resolve
  })
  const client = configClient(
    { BOTTEGA_RECORD_API_URL: 'https://record.test' },
    async () => {
      throw new Error('fixture transport failure')
    },
    'test',
    undefined,
    observationRecorded,
  )

  await expect(client.whoami()).rejects.toMatchObject({ reason: 'unreachable' })
  expect(await observation).toMatchObject({
    route: '/v1/whoami',
    status: null,
    error: expect.any(Error),
  })
})
