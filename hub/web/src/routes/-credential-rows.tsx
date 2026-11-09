import {
  type HostedProjectRow,
  type RecordConfigSecretsResponse,
  trpc,
} from '@bottega/hub-data/client'
import { useQuery } from '@tanstack/react-query'
import {
  type CredentialPreference,
  completeCredentialFields,
  credentialIdentityPath,
} from '../../../../shared/credential.ts'
import {
  type CredentialResolution,
  credentialMatchesPreferenceSlot,
  credentialPayerFromScope,
  resolveCredential,
} from '../../../../shared/credential-resolution.ts'

export type SecretRow = RecordConfigSecretsResponse[number]
export type TypedCredentialRow = SecretRow &
  NonNullable<ReturnType<typeof completeCredentialFields>>
export type CredentialUsage = {
  projectId: string | null
  name: string
  reason: Extract<CredentialResolution, { kind: 'resolved' }>['reason']
}
export type CredentialDisplayRow = {
  key: string
  credential: string
  mode: TypedCredentialRow['mode']
  environment: TypedCredentialRow['environment']
  boundTo: string
  owner: string
  hint: string
  updatedAt: string
  missing: boolean
  usages: CredentialUsage[]
  preferences: CredentialPreference[]
}

export const OWNER_LABEL: Record<SecretRow['scope'], string> = {
  user: 'You',
  space: 'This space',
}
const PAYER_LABEL = { personal: 'You', shared: 'Shared' } as const

export function splitSecretRows(rows: SecretRow[]): {
  credentials: TypedCredentialRow[]
  legacy: SecretRow[]
} {
  const credentials: TypedCredentialRow[] = []
  const legacy: SecretRow[] = []
  for (const row of rows) {
    const fields = completeCredentialFields(row)
    if (fields) credentials.push({ ...row, ...fields })
    else legacy.push(row)
  }
  return { credentials, legacy }
}

function projectName(projectId: string | null, projects: HostedProjectRow[], nullLabel: string) {
  if (projectId === null) return nullLabel
  return projects.find((project) => project.id === projectId)?.name ?? 'Unknown project'
}

function sameIdentity(
  left: Pick<TypedCredentialRow, 'provider' | 'name' | 'type' | 'mode' | 'environment'>,
  right: Pick<CredentialPreference, 'provider' | 'name' | 'type' | 'mode' | 'environment'>,
) {
  return (
    left.provider === right.provider &&
    left.name === right.name &&
    left.type === right.type &&
    left.mode === right.mode &&
    left.environment === right.environment
  )
}

function preferenceTargets(
  preference: CredentialPreference,
  projects: HostedProjectRow[],
  spaceId: string,
): (string | null)[] {
  if (preference.projectId !== null) return [preference.projectId]
  return [
    ...projects.filter((project) => project.spaceId === spaceId).map((project) => project.id),
    null,
  ]
}

function preferenceSelectsRow(
  preference: CredentialPreference,
  row: TypedCredentialRow,
  projects: HostedProjectRow[],
  spaceId: string,
) {
  if (!sameIdentity(row, preference)) return false
  const candidate = {
    ...row,
    payer: credentialPayerFromScope(row.scope),
    spaceId,
  }
  return preferenceTargets(preference, projects, spaceId).some((target) =>
    credentialMatchesPreferenceSlot(candidate, preference, target),
  )
}

function storedCredentialRowKey(row: TypedCredentialRow) {
  return `stored:${row.scope}:${row.projectId ?? 'space'}:${row.key}`
}

function missingCredentialRowKey(row: CredentialPreference) {
  return `missing:${row.projectId ?? 'space'}:${row.payer}:${row.binding}:${row.provider}:${row.name ?? ''}:${row.type}:${row.mode}:${row.environment}`
}

/** Project usage through the run resolver. Listings omit space ids, so candidates use the page's active spaceId. */
export function credentialDisplayRows(
  rows: TypedCredentialRow[],
  preferences: CredentialPreference[],
  projects: HostedProjectRow[],
  spaceId: string,
): CredentialDisplayRow[] {
  const candidates = rows.map((row) => ({
    ...row,
    payer: credentialPayerFromScope(row.scope),
    spaceId,
    rowKey: storedCredentialRowKey(row),
  }))
  const display: CredentialDisplayRow[] = rows.map((row) => ({
    key: storedCredentialRowKey(row),
    credential: credentialIdentityPath(row.provider, row.name, row.type),
    mode: row.mode,
    environment: row.environment,
    boundTo: projectName(row.projectId, projects, 'This space'),
    owner: OWNER_LABEL[row.scope],
    hint: row.hint,
    updatedAt: row.updatedAt,
    missing: false,
    usages: [],
    preferences: preferences.filter((preference) =>
      preferenceSelectsRow(preference, row, projects, spaceId),
    ),
  }))
  const byKey = new Map(display.map((row) => [row.key, row]))
  const identities = new Map(
    candidates.map((row) => [
      `${row.provider}:${row.name ?? ''}:${row.type}:${row.mode}:${row.environment}`,
      row,
    ]),
  )
  const targets = [
    ...projects
      .filter((project) => project.spaceId === spaceId)
      .map((project) => ({ id: project.id, name: project.name })),
    { id: null, name: 'Space default' },
  ]
  for (const identity of identities.values()) {
    for (const target of targets) {
      const result = resolveCredential({
        spaceId,
        projectId: target.id,
        projectName: target.id ? target.name : undefined,
        provider: identity.provider,
        name: identity.name,
        type: identity.type,
        mode: identity.mode,
        environment: identity.environment,
        candidates,
        preferences,
      })
      if (result.kind === 'resolved')
        byKey
          .get(result.credential.rowKey)
          ?.usages.push({ projectId: target.id, name: target.name, reason: result.reason })
    }
  }
  for (const preference of preferences) {
    if (rows.some((row) => preferenceSelectsRow(preference, row, projects, spaceId))) continue
    display.push({
      key: missingCredentialRowKey(preference),
      credential: credentialIdentityPath(preference.provider, preference.name, preference.type),
      mode: preference.mode,
      environment: preference.environment,
      boundTo: projectName(preference.projectId, projects, 'All projects'),
      owner: '—',
      hint: 'missing',
      updatedAt: preference.updatedAt,
      missing: true,
      usages: [],
      preferences: [preference],
    })
  }
  return display
}

export function preferenceDisplayLine(
  preference: CredentialPreference,
  projects: HostedProjectRow[],
) {
  return `${projectName(preference.projectId, projects, 'All projects')}: pays with ${PAYER_LABEL[preference.payer]}, ${preference.binding} credential`
}

export function credentialUsageReason(reason: CredentialUsage['reason']) {
  if (reason === 'project-preference') return 'preference for this project'
  if (reason === 'space-preference') return 'space-wide preference'
  return 'default order'
}

type CredentialRowsError = {
  source: 'credentials' | 'preferences' | 'projects' | 'identity'
  message: string
}

export function useCredentialRows() {
  const secrets = useQuery(trpc.record.configSecrets.queryOptions())
  const preferences = useQuery(trpc.record.credentialPreferences.queryOptions())
  const projects = useQuery(trpc.record.projects.queryOptions())
  const whoami = useQuery(trpc.record.whoami.queryOptions())
  const pending =
    secrets.isPending || preferences.isPending || projects.isPending || whoami.isPending
  const failed = [
    ['credentials', secrets.error],
    ['preferences', preferences.error],
    ['projects', projects.error],
    ['identity', whoami.error],
  ] as const
  const failure = failed.find((entry) => entry[1] !== null)
  const error: CredentialRowsError | null = failure
    ? { source: failure[0], message: failure[1].message }
    : null
  const projectsData = projects.data ?? []
  const split = splitSecretRows(secrets.data ?? [])
  const spaceId = whoami.data?.activeSpaceId ?? projectsData[0]?.spaceId ?? ''
  return {
    rows:
      pending || error
        ? []
        : credentialDisplayRows(split.credentials, preferences.data ?? [], projectsData, spaceId),
    legacy: split.legacy,
    secrets: secrets.data,
    projects: projectsData,
    spaceId,
    pending,
    error,
    secretsPending: secrets.isPending,
    secretsError: secrets.error,
  }
}
