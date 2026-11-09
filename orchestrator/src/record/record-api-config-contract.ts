// concern: record-api-config-contract
/** Declares the hosted config route service port. */

import type {
  ConfigEntry,
  ConfigScope,
  ConfigSecret,
  ConfigSecretMetadata,
  ConfigTenant,
  ConfigWrapInput,
  DataKey,
  MachineKey,
} from './record-config.ts'

type Tenant = Omit<ConfigTenant, 'spaceIds'> & { spaceIds: string[] }
export type RecordConfigRouteDeps = {
  listConfigEntries(input: Tenant & { environment?: string }): Promise<ConfigEntry[]>
  getConfigEntry(
    input: Tenant & { key: string; environment: string; scope: ConfigScope },
  ): Promise<ConfigEntry | null>
  putConfigEntry(
    input: Tenant & {
      key: string
      environment: string
      scope: ConfigScope
      value: string
      expectedRowVersion: number | null
    },
  ): Promise<ConfigEntry>
  deleteConfigEntry(
    input: Tenant & {
      key: string
      environment: string
      scope: ConfigScope
      expectedRowVersion: number
    },
  ): Promise<void>
  listConfigSecrets(input: Tenant & { environment?: string }): Promise<ConfigSecretMetadata[]>
  getConfigSecret(
    input: Tenant & {
      key: string
      environment: string
      scope: ConfigScope
      projectId?: string | null
    },
  ): Promise<ConfigSecret | null>
  putConfigSecret(
    input: Tenant & {
      key: string
      environment: string
      scope: ConfigScope
      dekId: string
      envelope: Uint8Array
      expectedRowVersion: number | null
      projectId?: string | null
      provider?: string | null
      type?: string | null
      hint?: string | null
      mode?: string | null
      reachSpaceIds?: string[] | null
    },
  ): Promise<ConfigSecretMetadata>
  deleteConfigSecret(
    input: Tenant & {
      key: string
      environment: string
      scope: ConfigScope
      expectedRowVersion: number
      projectId?: string | null
    },
  ): Promise<void>
  currentDataKey(input: Tenant & { recipientKeyId: string }): Promise<DataKey | null>
  listDataKeys(input: Tenant): Promise<DataKey[]>
  getDataKey(input: Tenant & { dekId: string; recipientKeyId: string }): Promise<DataKey | null>
  createDataKey(
    input: Tenant & { dekId: string; version: number; wraps: ConfigWrapInput[] },
  ): Promise<{ id: string; version: number }>
  addDataKeyWraps(input: Tenant & { dekId: string; wraps: ConfigWrapInput[] }): Promise<void>
  retireDataKey(input: Tenant & { dekId: string }): Promise<void>
  deleteDataKeyWraps(input: Tenant & { recipientKeyId: string }): Promise<void>
  listMachineKeys(input: Tenant): Promise<MachineKey[]>
  registerMachineKey(
    input: Tenant & { keyId: string; publicKey: Uint8Array; label: string },
  ): Promise<MachineKey>
  revokeMachineKey(input: Tenant & { keyId: string }): Promise<void>
}
