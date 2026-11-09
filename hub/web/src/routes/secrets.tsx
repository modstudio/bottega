import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { Callout } from '@bottega/hub-ui/callout'
import { Collection, type CollectionColumn } from '@bottega/hub-ui/collection'
import { EmptyState } from '@bottega/hub-ui/empty-state'
import { ErrorState } from '@bottega/hub-ui/error-state'
import { PageHeader } from '@bottega/hub-ui/page-header'
import { relativeTime } from '@bottega/hub-util/format'
import { createFileRoute, Navigate, useNavigate, useParams } from '@tanstack/react-router'
import { type CredentialDisplayRow, useCredentialRows } from '@/routes/-credential-rows'
import { useDetailPanel } from '@/routes/-detail-panel'
import { PLATFORM_SLUG } from '../../../../shared/brand.ts'

export const Route = createFileRoute('/secrets')({ component: SecretsRoute })

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

function SecretsRoute() {
  if (!isHostedMode()) return <Navigate to="/" />
  return <SecretsPage />
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
        <>
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
          {credentials.untypedCount > 0 ? (
            <Callout
              tone="neutral"
              title={`${credentials.untypedCount} sealed configuration ${credentials.untypedCount === 1 ? 'key is' : 'keys are'} not typed credentials. List ${credentials.untypedCount === 1 ? 'it' : 'them'} with ${PLATFORM_SLUG} machine config secret list.`}
            />
          ) : null}
        </>
      ) : null}
    </section>
  )
}
