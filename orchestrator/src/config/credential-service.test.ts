import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ConfigClient, ConfigClientError } from '../../../shared/config-client.ts'
import { generateMachineKeyPair } from '../../../shared/secret-envelope.ts'
import { writeMachineKey } from '../../../shared/machine-key-store.ts'
import { deleteCredential, setCredential, type CredentialAddress } from './credential-service.ts'

let root: string
let previousConfigHome: string | undefined
let previousKeystore: string | undefined

beforeEach(async () => {
  previousConfigHome = process.env.BOTTEGA_CONFIG_HOME
  previousKeystore = process.env.BOTTEGA_KEYSTORE
  root = mkdtempSync(join(tmpdir(), 'credential-service-'))
  process.env.BOTTEGA_CONFIG_HOME = root
  process.env.BOTTEGA_KEYSTORE = 'file'
  writeMachineKey(await generateMachineKeyPair())
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  if (previousConfigHome === undefined) delete process.env.BOTTEGA_CONFIG_HOME
  else process.env.BOTTEGA_CONFIG_HOME = previousConfigHome
  if (previousKeystore === undefined) delete process.env.BOTTEGA_KEYSTORE
  else process.env.BOTTEGA_KEYSTORE = previousKeystore
})

const address: CredentialAddress = {
  provider: 'openrouter',
  type: 'api-key',
  environment: 'default',
  payer: 'personal',
  projectId: '01990000-0000-7000-8000-000000000001',
  projectName: 'alpha',
  spaceName: 'studio',
  destinationSpaceId: '01990000-0000-7000-8000-000000000002',
}

test('set credential gives the project access remedy for every missing wrap outcome', async () => {
  for (const currentDataKey of [
    async () => {
      throw new ConfigClientError('response', '/v1/config/data-keys/current', 404)
    },
    async () => ({
      id: '01990000-0000-7000-8000-000000000003',
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      retiredAt: null,
      wraps: [],
    }),
  ]) {
    const createDataKey = mock(async () => ({ id: '', version: 1 }))
    const client = { currentDataKey, createDataKey } as unknown as ConfigClient
    await expect(setCredential(address, 'secret', client)).rejects.toThrow('record space switch')
    await expect(setCredential(address, 'secret', client)).rejects.toThrow(
      'record space access grant',
    )
    expect(createDataKey).not.toHaveBeenCalled()
  }
})

test('delete credential explains how to recreate an absent project credential', async () => {
  const client = {
    getSecret: async () => {
      throw new ConfigClientError('response', '/v1/config/secrets/OPENROUTER_API_KEY', 404)
    },
  } as unknown as ConfigClient
  await expect(deleteCredential(address, client)).rejects.toThrow(
    'credential set openrouter/api-key --project alpha',
  )
})
