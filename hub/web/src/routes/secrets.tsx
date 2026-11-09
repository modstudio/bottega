import {
  type HostedProjectRow,
  type RecordConfigSecretsResponse,
  trpc,
} from '@bottega/hub-data/client'
import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { Collection, type CollectionColumn } from '@bottega/hub-ui/collection'
import { EmptyState } from '@bottega/hub-ui/empty-state'
import { ErrorState } from '@bottega/hub-ui/error-state'
import { PageHeader } from '@bottega/hub-ui/page-header'
import { relativeTime } from '@bottega/hub-util/format'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Navigate, useNavigate, useParams } from '@tanstack/react-router'
import { useDetailPanel } from '@/routes/-detail-panel'
import { PLATFORM_SLUG } from '../../../../shared/brand.ts'
import {
  type CredentialPreference,
  completeCredentialFields,
  credentialIdentityPath,
} from '../../../../shared/credential.ts'
import {
  type CredentialResolution,
  credentialPayerFromScope,
  resolveCredential,
} from '../../../../shared/credential-resolution.ts'

export const Route = createFileRoute('/secrets')({ component: SecretsRoute })
type SecretRow = RecordConfigSecretsResponse[number]
export type TypedCredentialRow = SecretRow &
  NonNullable<ReturnType<typeof completeCredentialFields>>
type CredentialUsage = {
  projectId: string | null
  name: string
  reason: Extract<CredentialResolution['reason'], string>
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

const CREDENTIAL_COMMAND = `${PLATFORM_SLUG} credential`
const OWNER_LABEL: Record<SecretRow['scope'], string> = { user: 'You', space: 'This space' }

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

function preferenceSelectsRow(preference: CredentialPreference, row: TypedCredentialRow) {
  return (
    sameIdentity(row, preference) &&
    credentialPayerFromScope(row.scope) === preference.payer &&
    (preference.binding === 'project'
      ? row.projectId === preference.projectId && preference.projectId !== null
      : row.projectId === null)
  )
}

function storedRowKey(row: TypedCredentialRow) {
  return `stored:${row.scope}:${row.projectId ?? 'space'}:${row.key}`
}

function missingRowKey(row: CredentialPreference) {
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
    rowKey: storedRowKey(row),
  }))
  const display: CredentialDisplayRow[] = rows.map((row) => ({
    key: storedRowKey(row),
    credential: credentialIdentityPath(row.provider, row.name, row.type),
    mode: row.mode,
    environment: row.environment,
    boundTo: projectName(row.projectId, projects, 'This space'),
    owner: OWNER_LABEL[row.scope],
    hint: row.hint,
    updatedAt: row.updatedAt,
    missing: false,
    usages: [],
    preferences: preferences.filter((preference) => preferenceSelectsRow(preference, row)),
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
    if (rows.some((row) => preferenceSelectsRow(preference, row))) continue
    const target = projectName(preference.projectId, projects, 'All projects')
    display.push({
      key: missingRowKey(preference),
      credential: credentialIdentityPath(preference.provider, preference.name, preference.type),
      mode: preference.mode,
      environment: preference.environment,
      boundTo: target,
      owner: '—',
      hint: 'missing',
      updatedAt: preference.updatedAt,
      missing: true,
      usages: [
        {
          projectId: preference.projectId,
          name: target,
          reason: preference.projectId === null ? 'space-preference' : 'project-preference',
        },
      ],
      preferences: [preference],
    })
  }
  return display
}

function usedByText(row: CredentialDisplayRow) {
  return row.usages.length
    ? row.usages
        .map((usage) =>
          usage.reason === 'default-order' ? usage.name : `${usage.name} (preferred)`,
        )
        .join(', ')
    : '—'
}

const credentialColumns: CollectionColumn<CredentialDisplayRow>[] = [
  { id: 'credential', label: 'Credential', phone: 'title', render: (row) => row.credential },
  { id: 'mode', label: 'Mode', phone: 'aside', render: (row) => row.mode },
  { id: 'binding', label: 'Bound to', phone: 'line', render: (row) => row.boundTo },
  { id: 'owner', label: 'Owner', phone: 'line', render: (row) => row.owner },
  { id: 'used-by', label: 'Used by', phone: 'line', grow: true, render: usedByText },
  {
    id: 'hint',
    label: 'Hint',
    phone: 'more',
    render: (row) =>
      row.missing ? (
        <span data-tone="warning" className="text-status-text">
          missing
        </span>
      ) : (
        row.hint
      ),
  },
  {
    id: 'changed',
    label: 'Last changed',
    phone: 'more',
    render: (row) => relativeTime(row.updatedAt),
  },
]

const legacyColumns: CollectionColumn<SecretRow>[] = [
  { id: 'name', label: 'Name', phone: 'title', render: (row) => row.key },
  { id: 'owner', label: 'Belongs to', phone: 'aside', render: (row) => OWNER_LABEL[row.scope] },
  {
    id: 'changed',
    label: 'Last changed',
    phone: 'line',
    render: (row) => relativeTime(row.updatedAt),
  },
]

function SecretsRoute() {
  if (!isHostedMode()) return <Navigate to="/" />
  return <SecretsPage />
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
      getKey={(row) => `${row.scope}:${row.environment}:${row.key}`}
      onOpen={() => undefined}
      empty={{
        title: 'No legacy keys in this space.',
        hint: `Set one with ${PLATFORM_SLUG} machine config secret set.`,
      }}
    />
  )
}

function SecretsPage() {
  const navigate = useNavigate()
  const panel = useDetailPanel()
  const selectedKey = useParams({ strict: false }).credentialKey
  const secrets = useQuery(trpc.record.configSecrets.queryOptions())
  const preferences = useQuery(trpc.record.credentialPreferences.queryOptions())
  const projects = useQuery(trpc.record.projects.queryOptions())
  const whoami = useQuery(trpc.record.whoami.queryOptions())
  const spaceId = whoami.data?.activeSpaceId ?? projects.data?.[0]?.spaceId ?? ''
  const rows = credentialDisplayRows(
    splitSecretRows(secrets.data ?? []).credentials,
    preferences.data ?? [],
    projects.data ?? [],
    spaceId,
  )
  const pending = secrets.isPending || preferences.isPending || whoami.isPending
  const error = secrets.error ?? preferences.error ?? whoami.error
  return (
    <section>
      <PageHeader
        title="Secrets"
        about={`Set and delete values with ${CREDENTIAL_COMMAND} set and ${CREDENTIAL_COMMAND} delete, and choose which copy a project uses with ${CREDENTIAL_COMMAND} prefer. Values never reach this page.`}
      />
      {projects.error ? (
        <p data-tone="error" className="mb-3 text-status-text">
          <strong>Could not load project names:</strong> {projects.error.message}
        </p>
      ) : null}
      {pending ? <EmptyState title="Loading credentials..." /> : null}
      {error ? <ErrorState title="Could not load credentials" message={error.message} /> : null}
      {!pending && !error ? (
        <Collection
          title="Credentials"
          count={rows.length}
          panel={panel}
          selectedKey={selectedKey}
          columns={credentialColumns}
          rows={rows}
          getKey={(row) => row.key}
          onOpen={(row) =>
            void navigate({
              to: '/secrets/$credentialKey',
              params: { credentialKey: row.key },
              resetScroll: false,
            })
          }
          empty={{
            title: 'No credentials in this space.',
            hint: `Set one with ${CREDENTIAL_COMMAND} set.`,
          }}
        />
      ) : null}
      <LegacyKeysCollection
        secrets={secrets.data}
        pending={secrets.isPending}
        error={secrets.error}
      />
    </section>
  )
}
