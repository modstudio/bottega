import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import type { inferRouterOutputs } from '@trpc/server'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Collection, type CollectionColumn } from '@/components/collection'
import { useDetailPanel } from '@/lib/detail-panel'
import { sendTimestamp } from '@/lib/format'
import { isHostedMode } from '@/lib/hub-mode'
import { queryClient, trpc } from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { Button } from '@/ui/button/button'
import { Checkbox } from '@/ui/checkbox/checkbox'
import { Dialog } from '@/ui/dialog/dialog'
import { Input } from '@/ui/field/input'
import { Textarea } from '@/ui/field/textarea'
import { SettingBlock } from '@/ui/form-layout/form-layout'
import { PageHeader } from '@/ui/page-header/page-header'
import { Segmented } from '@/ui/segmented/segmented'
import type { AppRouter } from '../../../src/trpc/router.ts'

type BoardOutputs = inferRouterOutputs<AppRouter>['board']
export type BoardListRow = BoardOutputs['list']['messages'][number]
type BoardListOrigin = BoardListRow['origin']

type Filter = 'all' | 'notice' | 'question' | 'open'

export const Route = createFileRoute('/messages')({ component: MessagesRoute })

function MessagesRoute() {
  return <LocalMessagesPage />
}

function listInput(filter: Filter, includeEnded: boolean) {
  return {
    ...(filter === 'notice' ? { kind: 'notice' as const } : {}),
    ...(filter === 'question' || filter === 'open' ? { kind: 'question' as const } : {}),
    ...(filter === 'open' ? { open: true } : {}),
    ...(includeEnded ? { includeEnded: true } : {}),
  }
}

export function originText(origin: BoardListOrigin) {
  if (origin.kind === 'operator') return 'Operator'
  if (origin.runId) return `Run ${origin.runId}`
  if (origin.session) {
    const context = [origin.harness, origin.project].filter(Boolean).join(', ')
    return `Architect ${origin.session}${context ? ` (${context})` : ''}`
  }
  return origin.kind
}

function reachText(row: BoardListRow) {
  if (row.reached === null) return 'Reach unknown'
  if (row.reached === 0) return 'Reached no session'
  if (!row.ackRequired) return `${row.reached} reached`
  return `${row.acknowledged ?? 0} of ${row.reached} acknowledged`
}

function responseText(row: BoardListRow) {
  if (row.kind === 'notice') return reachText(row)
  return `${row.replyCount} ${row.replyCount === 1 ? 'reply' : 'replies'} · ${row.acceptedReplyId ? 'answer accepted' : 'no answer accepted'}`
}

function MessagesList({
  rows,
  warning,
  emptyTitle = 'No messages match these filters.',
  selectedId,
  panel,
  onOpen,
  controls,
}: {
  rows: BoardListRow[]
  warning: string | null
  emptyTitle?: string
  selectedId?: string
  panel?: React.ReactNode
  onOpen: (row: BoardListRow) => void
  controls?: React.ReactNode
}) {
  const columns: CollectionColumn<BoardListRow>[] = [
    {
      id: 'title',
      label: 'Message',
      grow: true,
      render: (row) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium">{row.title ?? '(Untitled)'}</span>
          <span className="block truncate text-sm text-text-muted">{originText(row.origin)}</span>
        </span>
      ),
    },
    { id: 'kind', label: 'Kind', priority: 'low', render: (row) => row.kind },
    {
      id: 'audience',
      label: 'Audience',
      priority: 'low',
      render: (row) => row.audience ?? '-',
    },
    {
      id: 'state',
      label: 'State',
      render: (row) => (
        <Badge tone={row.state === 'open' ? 'progress' : 'neutral'}>{row.state}</Badge>
      ),
    },
    { id: 'response', label: 'Reach / replies', render: responseText },
    {
      id: 'expires',
      label: 'Expires',
      priority: 'low',
      render: (row) => (row.expiresAt ? sendTimestamp(row.expiresAt) : 'Never'),
    },
    {
      id: 'open',
      label: '',
      render: () => <ChevronRight size={14} className="text-text-muted" />,
    },
  ]
  return (
    <>
      {warning ? (
        <p data-tone="warning" className="mb-3 text-status-text">
          {warning}
        </p>
      ) : null}
      <Collection
        title="Messages"
        count={rows.length}
        actions={controls}
        panel={panel}
        selectedKey={selectedId}
        columns={columns}
        rows={rows}
        getKey={(row) => row.id}
        onOpen={onOpen}
        empty={{ title: emptyTitle }}
      />
    </>
  )
}

function LocalMessagesPage() {
  const navigate = useNavigate()
  const panel = useDetailPanel()
  const selectedId = useParams({ strict: false }).id
  return (
    <MessagesContent
      panel={panel}
      selectedId={selectedId}
      onOpen={(row) =>
        void navigate({ to: '/messages/$id', params: { id: row.id }, resetScroll: false })
      }
    />
  )
}

export function MessagesContent({
  panel,
  selectedId,
  onOpen,
}: {
  panel?: React.ReactNode
  selectedId?: string
  onOpen: (row: BoardListRow) => void
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const [includeEnded, setIncludeEnded] = useState(false)
  const [posting, setPosting] = useState(false)
  const query = useQuery(trpc.board.list.queryOptions(listInput(filter, includeEnded)))
  const rows = query.data?.messages ?? []

  return (
    <section>
      <PageHeader title="Messages" subtitle="Operator messages, questions, and receipts" />
      {query.error ? (
        <p data-tone="error" className="mb-3 text-status-text">
          {query.error.message}
        </p>
      ) : null}
      <MessagesList
        rows={rows}
        warning={query.data?.warning ?? null}
        emptyTitle={
          query.isPending
            ? 'Loading messages...'
            : query.error
              ? 'Messages could not be loaded.'
              : undefined
        }
        selectedId={selectedId}
        panel={panel}
        onOpen={onOpen}
        controls={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              label="Message filter"
              value={filter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'notice', label: 'Notices' },
                { value: 'question', label: 'Questions' },
                { value: 'open', label: 'Open questions' },
              ]}
              onChange={(value) => setFilter(value as Filter)}
            />
            <label htmlFor="show-ended" className="flex items-center gap-2 text-sm text-text-muted">
              <Checkbox
                id="show-ended"
                checked={includeEnded}
                onChange={(event) => setIncludeEnded(event.target.checked)}
              />
              Show ended
            </label>
            <Button size="sm" onClick={() => void query.refetch()}>
              <RefreshCw /> Refresh
            </Button>
            <Button size="sm" variant="primary" onClick={() => setPosting(true)}>
              New message
            </Button>
          </div>
        }
      />
      <NewMessageDialog open={posting} onOpenChange={setPosting} />
    </section>
  )
}

function splitValues(value: string) {
  const values = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  return values.length ? values : undefined
}

function NewMessageDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [audience, setAudience] = useState('')
  const [project, setProject] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [ackRequired, setAckRequired] = useState(false)
  const [deadline, setDeadline] = useState('')
  const [expires, setExpires] = useState('')
  const [task, setTask] = useState('')
  const [paths, setPaths] = useState('')
  const [topics, setTopics] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const hosted = isHostedMode()
  const post = useMutation(
    trpc.board.post.mutationOptions({
      onSuccess: async (posted) => {
        setResult(
          posted.warning ??
            (posted.reached === null
              ? 'Message posted. Reach is unknown.'
              : `Message posted and reached ${posted.reached} ${posted.reached === 1 ? 'session' : 'sessions'}.`),
        )
        setAudience('')
        setProject('')
        setTitle('')
        setBody('')
        setAckRequired(false)
        setDeadline('')
        setExpires('')
        setTask('')
        setPaths('')
        setTopics('')
        post.reset()
        await queryClient.invalidateQueries({ queryKey: trpc.board.list.queryKey() })
      },
    }),
  )
  const submit = () => {
    setResult(null)
    post.mutate({
      audience,
      ...(hosted && project ? { project } : {}),
      title,
      body,
      ...(task ? { task } : {}),
      ...(splitValues(paths) ? { paths: splitValues(paths) } : {}),
      ...(splitValues(topics) ? { topics: splitValues(topics) } : {}),
      ...(ackRequired ? { ackRequired: true, ...(deadline ? { deadline } : {}) } : {}),
      ...(expires ? { expires } : {}),
    })
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New message"
      description="Post a notice from the operator."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
          <Button
            variant="primary"
            disabled={post.isPending || !audience || !title.trim() || !body.trim()}
            onClick={submit}
          >
            {post.isPending ? 'Posting...' : 'Post message'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <SettingBlock
          label="Audience"
          hint={
            hosted
              ? 'project:<name>, task:<KEY>, session:<id>, run:<id>, or architects'
              : 'project:<name>, task:<KEY>, session:<id>, run:<id>, architects, or machine:this'
          }
          control={<Input value={audience} onChange={(event) => setAudience(event.target.value)} />}
        />
        {hosted ? (
          <SettingBlock
            label="Project (optional)"
            control={<Input value={project} onChange={(event) => setProject(event.target.value)} />}
          />
        ) : null}
        <SettingBlock
          label="Title"
          control={<Input value={title} onChange={(event) => setTitle(event.target.value)} />}
        />
        <SettingBlock
          label="Body"
          control={<Textarea value={body} onChange={(event) => setBody(event.target.value)} />}
        />
        <label
          htmlFor="ack-required"
          className="flex items-center gap-2 text-sm text-text-secondary"
        >
          <Checkbox
            id="ack-required"
            checked={ackRequired}
            onChange={(event) => setAckRequired(event.target.checked)}
          />
          Acknowledgement required
        </label>
        {ackRequired ? (
          <SettingBlock
            label="Acknowledgement deadline duration"
            control={
              <Input value={deadline} onChange={(event) => setDeadline(event.target.value)} />
            }
          />
        ) : null}
        <SettingBlock
          label="Expiry duration"
          control={<Input value={expires} onChange={(event) => setExpires(event.target.value)} />}
        />
        <SettingBlock
          label="Task key (optional)"
          control={<Input value={task} onChange={(event) => setTask(event.target.value)} />}
        />
        <SettingBlock
          label="Path globs (optional, comma separated)"
          control={<Input value={paths} onChange={(event) => setPaths(event.target.value)} />}
        />
        <SettingBlock
          label="Topics (optional, comma separated)"
          control={<Input value={topics} onChange={(event) => setTopics(event.target.value)} />}
        />
        {post.error ? (
          <p data-tone="error" className="text-status-text">
            {post.error.message}
          </p>
        ) : null}
        {result ? (
          <p data-tone="success" className="text-status-text">
            {result}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
