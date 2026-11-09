import {
  type HostedProjectRow,
  queryClient,
  type RecordConfigSecretsResponse,
  trpc,
} from '@bottega/hub-data/client'
import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { Button } from '@bottega/hub-ui/button'
import { Collection, type CollectionColumn } from '@bottega/hub-ui/collection'
import { EmptyState } from '@bottega/hub-ui/empty-state'
import { ErrorState } from '@bottega/hub-ui/error-state'
import { PageHeader } from '@bottega/hub-ui/page-header'
import { relativeTime } from '@bottega/hub-util/format'
import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, Navigate } from '@tanstack/react-router'
import { PLATFORM_SLUG } from '../../../../shared/brand.ts'
import {
  type CredentialPreference,
  completeCredentialFields,
  credentialIdentityPath,
} from '../../../../shared/credential.ts'

export const Route = createFileRoute('/secrets')({ component: SecretsRoute })

type SecretRow = RecordConfigSecretsResponse[number]
type TypedCredentialRow = SecretRow & NonNullable<ReturnType<typeof completeCredentialFields>>

export type CredentialDisplayRow = TypedCredentialRow & {
  credential: string
  boundTo: string
  payer: string
}

export type PreferenceDisplayRow = CredentialPreference & {
  credential: string
  project: string
  paysWith: string
}

const CREDENTIAL_COMMAND = `${PLATFORM_SLUG} credential`
const LEGACY_OWNER_LABEL: Record<SecretRow['scope'], string> = {
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

function projectName(
  projectId: string | null,
  projects: HostedProjectRow[],
  nullProjectLabel: string,
): string {
  if (projectId === null) return nullProjectLabel
  return projects.find((project) => project.id === projectId)?.name ?? 'Unknown project'
}

export function credentialDisplayRows(
  rows: TypedCredentialRow[],
  projects: HostedProjectRow[],
): CredentialDisplayRow[] {
  return rows.map((row) => ({
    ...row,
    credential: credentialIdentityPath(row.provider, row.name, row.type),
    boundTo: projectName(row.projectId, projects, 'This space'),
    payer: row.scope === 'user' ? 'You' : 'Shared',
  }))
}

export function preferenceDisplayRows(
  rows: CredentialPreference[],
  projects: HostedProjectRow[],
): PreferenceDisplayRow[] {
  return rows.map((row) => ({
    ...row,
    credential: credentialIdentityPath(row.provider, row.name, row.type),
    project: projectName(row.projectId, projects, 'All projects'),
    paysWith: `${PAYER_LABEL[row.payer]}, ${row.binding} credential`,
  }))
}

const credentialColumns: CollectionColumn<CredentialDisplayRow>[] = [
  {
    id: 'credential',
    label: 'Credential',
    phone: 'title',
    render: (row) => row.credential,
  },
  { id: 'mode', label: 'Mode', phone: 'aside', render: (row) => row.mode },
  { id: 'binding', label: 'Bound to', phone: 'line', render: (row) => row.boundTo },
  { id: 'payer', label: 'Payer', phone: 'line', render: (row) => row.payer },
  { id: 'hint', label: 'Hint', phone: 'more', render: (row) => row.hint },
  {
    id: 'changed',
    label: 'Last changed',
    phone: 'more',
    render: (row) => relativeTime(row.updatedAt),
  },
]

const preferenceColumns: CollectionColumn<PreferenceDisplayRow>[] = [
  {
    id: 'credential',
    label: 'Credential',
    phone: 'title',
    render: (row) => row.credential,
  },
  { id: 'mode', label: 'Mode', phone: 'aside', render: (row) => row.mode },
  { id: 'project', label: 'Project', phone: 'line', render: (row) => row.project },
  { id: 'payer', label: 'Pays with', phone: 'line', render: (row) => row.paysWith },
  {
    id: 'changed',
    label: 'Last changed',
    phone: 'more',
    render: (row) => relativeTime(row.updatedAt),
  },
]

const legacyColumns: CollectionColumn<SecretRow>[] = [
  { id: 'name', label: 'Name', phone: 'title', render: (secret) => secret.key },
  {
    id: 'owner',
    label: 'Belongs to',
    phone: 'aside',
    render: (secret) => LEGACY_OWNER_LABEL[secret.scope],
  },
  {
    id: 'changed',
    label: 'Last changed',
    phone: 'line',
    render: (secret) => relativeTime(secret.updatedAt),
  },
]

function SecretsRoute() {
  if (!isHostedMode()) return <Navigate to="/" />
  return <SecretsPage />
}

type ProjectDependentProps = {
  projects: HostedProjectRow[] | undefined
  projectsPending: boolean
  projectsError: { message: string } | null
}

function CredentialsCollection({
  secrets,
  secretsPending,
  secretsError,
  projects,
  projectsPending,
  projectsError,
}: ProjectDependentProps & {
  secrets: SecretRow[] | undefined
  secretsPending: boolean
  secretsError: { message: string } | null
}) {
  if (secretsPending || projectsPending) return <EmptyState title="Loading credentials..." />
  const error = secretsError ?? projectsError
  if (error) return <ErrorState title="Could not load credentials" message={error.message} />
  const split = splitSecretRows(secrets ?? [])
  const rows = credentialDisplayRows(split.credentials, projects ?? [])
  return (
    <Collection
      title="Credentials"
      count={rows.length}
      columns={credentialColumns}
      rows={rows}
      getKey={(row) => `${row.scope}:${row.projectId ?? 'space'}:${row.environment}:${row.key}`}
      onOpen={() => undefined}
      empty={{
        title: 'No credentials in this space.',
        hint: `Set one with ${CREDENTIAL_COMMAND} set.`,
      }}
    />
  )
}

function PreferencesCollection({
  preferences,
  preferencesPending,
  preferencesError,
  projects,
  projectsPending,
  projectsError,
  onClear,
  clearPending,
  clearError,
}: ProjectDependentProps & {
  preferences: CredentialPreference[] | undefined
  preferencesPending: boolean
  preferencesError: { message: string } | null
  onClear: (row: CredentialPreference) => void
  clearPending: boolean
  clearError: { message: string } | null
}) {
  if (preferencesPending || projectsPending)
    return <EmptyState title="Loading payer preferences..." />
  const error = preferencesError ?? projectsError
  if (error) return <ErrorState title="Could not load payer preferences" message={error.message} />
  const rows = preferenceDisplayRows(preferences ?? [], projects ?? [])
  return (
    <>
      <Collection
        title="Payer preferences"
        count={rows.length}
        columns={preferenceColumns}
        rows={rows}
        getKey={(row) =>
          `${row.projectId ?? 'space'}:${row.credential}:${row.mode}:${row.environment}`
        }
        onOpen={() => undefined}
        rowActions={(row) => (
          <Button
            size="sm"
            variant="secondary"
            disabled={clearPending}
            onClick={() => onClear(row)}
          >
            Clear
          </Button>
        )}
        empty={{
          title: 'No payer preferences in this space.',
          hint: `Choose one with ${CREDENTIAL_COMMAND} prefer.`,
        }}
      />
      {clearError ? (
        <p data-tone="error" className="mb-3 text-status-text">
          {clearError.message}
        </p>
      ) : null}
    </>
  )
}

function LegacyKeysCollection({
  secrets,
  pending,
  error,
}: {
  secrets: SecretRow[] | undefined
  pending: boolean
  error: { message: string } | null
}) {
  if (pending) return <EmptyState title="Loading legacy keys..." />
  if (error) return <ErrorState title="Could not load legacy keys" message={error.message} />
  const rows = splitSecretRows(secrets ?? []).legacy
  return (
    <Collection
      title="Legacy keys"
      count={rows.length}
      columns={legacyColumns}
      rows={rows}
      getKey={(secret) => `${secret.scope}:${secret.environment}:${secret.key}`}
      onOpen={() => undefined}
      empty={{
        title: 'No legacy keys in this space.',
        hint: `Set one with ${PLATFORM_SLUG} machine config secret set.`,
      }}
    />
  )
}

function SecretsPage() {
  const secrets = useQuery(trpc.record.configSecrets.queryOptions())
  const preferences = useQuery(trpc.record.credentialPreferences.queryOptions())
  const projects = useQuery(trpc.record.projects.queryOptions())
  const clearPreference = useMutation(
    trpc.record.clearCredentialPreference.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({
          queryKey: trpc.record.credentialPreferences.queryKey(),
        }),
    }),
  )
  const projectProps = {
    projects: projects.data,
    projectsPending: projects.isPending,
    projectsError: projects.error,
  }
  return (
    <section>
      <PageHeader
        title="Secrets"
        about={`Set and delete values with ${CREDENTIAL_COMMAND} set and ${CREDENTIAL_COMMAND} delete, and choose a payer with ${CREDENTIAL_COMMAND} prefer. Values never reach this page.`}
      />
      <CredentialsCollection
        secrets={secrets.data}
        secretsPending={secrets.isPending}
        secretsError={secrets.error}
        {...projectProps}
      />
      <PreferencesCollection
        preferences={preferences.data}
        preferencesPending={preferences.isPending}
        preferencesError={preferences.error}
        onClear={(row) => clearPreference.mutate(row)}
        clearPending={clearPreference.isPending}
        clearError={clearPreference.error}
        {...projectProps}
      />
      <LegacyKeysCollection
        secrets={secrets.data}
        pending={secrets.isPending}
        error={secrets.error}
      />
    </section>
  )
}
