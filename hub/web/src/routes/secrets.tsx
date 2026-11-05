import { type RecordConfigSecretsResponse, trpc } from '@bottega/hub-data/client'
import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { Collection, type CollectionColumn } from '@bottega/hub-ui/collection'
import { EmptyState } from '@bottega/hub-ui/empty-state'
import { ErrorState } from '@bottega/hub-ui/error-state'
import { PageHeader } from '@bottega/hub-ui/page-header'
import { relativeTime } from '@bottega/hub-util/format'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Navigate } from '@tanstack/react-router'
import { PLATFORM_SLUG } from '../../../../shared/brand.ts'

export const Route = createFileRoute('/secrets')({ component: SecretsRoute })

type SecretRow = RecordConfigSecretsResponse[number]

const SECRET_COMMAND = `${PLATFORM_SLUG} machine config secret`

const OWNER_LABEL: Record<SecretRow['scope'], string> = { user: 'You', space: 'This space' }

const columns: CollectionColumn<SecretRow>[] = [
  { id: 'name', label: 'Name', phone: 'title', render: (secret) => secret.key },
  {
    id: 'owner',
    label: 'Belongs to',
    phone: 'aside',
    render: (secret) => OWNER_LABEL[secret.scope],
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

function SecretsPage() {
  const secrets = useQuery(trpc.record.configSecrets.queryOptions())
  return (
    <section>
      <PageHeader
        title="Secrets"
        about={`Sealed secrets your machines resolve when they run a command. This page lists their names only; values are encrypted for the machines that hold config access and never reach this page. Set or remove one with ${SECRET_COMMAND}.`}
      />
      {secrets.isPending ? (
        <EmptyState title="Loading secrets..." />
      ) : secrets.error ? (
        <ErrorState title="Could not load secrets" message={secrets.error.message} />
      ) : (
        <Collection
          title="Secrets"
          count={secrets.data.length}
          columns={columns}
          rows={secrets.data}
          getKey={(secret) => `${secret.scope}:${secret.key}`}
          onOpen={() => undefined}
          empty={{
            title: 'No secrets in this space.',
            hint: `Set one with ${SECRET_COMMAND} set.`,
          }}
        />
      )}
    </section>
  )
}
