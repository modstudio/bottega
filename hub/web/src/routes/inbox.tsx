import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { Collection, type CollectionColumn } from '@/components/collection'
import { relativeTime } from '@/lib/format'
import { type WaitingInboxEntry, waitingInboxEntries } from '@/lib/operator-waiting'
import { trpc } from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { Identifier } from '@/ui/identifier/identifier'
import { PageHeader } from '@/ui/page-header/page-header'

export const Route = createFileRoute('/inbox')({ component: InboxPage })

type WaitingItem = WaitingInboxEntry

function useWaiting() {
  return useQuery(trpc.operator.waiting.queryOptions(undefined, { refetchInterval: 20_000 }))
}

function InboxPage() {
  const navigate = useNavigate()
  const waiting = useWaiting()
  const columns: CollectionColumn<WaitingItem>[] = [
    { id: 'project', label: 'Project', render: (item) => item.project ?? 'no project' },
    {
      id: 'task',
      label: 'Task',
      render: (item) => (item.task_key ? <Identifier>{item.task_key}</Identifier> : '-'),
    },
    {
      id: 'question',
      label: 'Question',
      grow: true,
      render: (item) => (
        <span className="block max-w-2xl truncate">
          {item.kind === 'question' && item.questionCount > 1
            ? `${item.questionCount} questions`
            : item.question}
        </span>
      ),
    },
    {
      id: 'waited',
      label: 'Waiting',
      render: (item) => relativeTime(item.waiting_since),
    },
    {
      id: 'kind',
      label: 'Kind',
      render: (item) => <Badge>{item.kind}</Badge>,
    },
    {
      id: 'open',
      label: '',
      render: () => <ChevronRight size={14} className="text-text-muted" />,
    },
  ]
  return (
    <section>
      <PageHeader
        title="Waiting on you"
        subtitle="Questions and workflow rulings that need an operator."
      />
      {waiting.error ? (
        <p data-tone="error" className="text-status-text">
          Could not load the inbox: {waiting.error.message}
        </p>
      ) : null}
      <Collection
        title="Inbox"
        count={waitingInboxEntries(waiting.data ?? []).length}
        columns={columns}
        rows={waitingInboxEntries(waiting.data ?? [])}
        getKey={(item) => `${item.kind}:${item.id}`}
        onOpen={(item) =>
          void navigate({
            to: '/inbox/$kind/$id',
            params: { kind: item.kind, id: String(item.id) },
          })
        }
        empty={{
          title: waiting.isPending ? 'Loading inbox...' : 'Nothing is waiting on you.',
          hint: waiting.isPending ? undefined : 'New operator questions appear here automatically.',
        }}
      />
    </section>
  )
}
