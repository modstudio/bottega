import type { RecordConfigSecretsResponse } from '@bottega/hub-data/client'
import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { Collection, type CollectionColumn } from '@bottega/hub-ui/collection'
import { EmptyState } from '@bottega/hub-ui/empty-state'
import { ErrorState } from '@bottega/hub-ui/error-state'
import { PageHeader } from '@bottega/hub-ui/page-header'
import { relativeTime } from '@bottega/hub-util/format'
import { createFileRoute, Navigate, useNavigate, useParams } from '@tanstack/react-router'
import {
  type CredentialDisplayRow,
  OWNER_LABEL,
  splitSecretRows,
  useCredentialRows,
} from '@/routes/-credential-rows'
import { useDetailPanel } from '@/routes/-detail-panel'
import { PLATFORM_SLUG } from '../../../../shared/brand.ts'

export const Route = createFileRoute('/secrets')({ component: SecretsRoute })
type SecretRow = RecordConfigSecretsResponse[number]

const CREDENTIAL_COMMAND = `${PLATFORM_SLUG} credential`

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
  const credentials = useCredentialRows()
  return (
    <section>
      <PageHeader
        title="Secrets"
        about={`Set and delete values with ${CREDENTIAL_COMMAND} set and ${CREDENTIAL_COMMAND} delete, and choose which copy a project uses with ${CREDENTIAL_COMMAND} prefer. Values never reach this page.`}
      />
      {credentials.pending ? <EmptyState title="Loading credentials..." /> : null}
      {credentials.error ? (
        <ErrorState
          title={`Could not load ${credentials.error.source}`}
          message={credentials.error.message}
        />
      ) : null}
      {!credentials.pending && !credentials.error ? (
        <Collection
          title="Credentials"
          count={credentials.rows.length}
          panel={panel}
          selectedKey={selectedKey}
          columns={credentialColumns}
          rows={credentials.rows}
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
        secrets={credentials.secrets}
        pending={credentials.secretsPending}
        error={credentials.secretsError}
      />
    </section>
  )
}
