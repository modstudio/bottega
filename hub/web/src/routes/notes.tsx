import { queryClient, trpc } from '@bottega/hub-data/client'
import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { Badge } from '@bottega/hub-ui/badge'
import { Button } from '@bottega/hub-ui/button'
import { Checkbox } from '@bottega/hub-ui/checkbox'
import { Collection, type CollectionColumn } from '@bottega/hub-ui/collection'
import { Dialog } from '@bottega/hub-ui/dialog'
import { ErrorState } from '@bottega/hub-ui/error-state'
import { Input } from '@bottega/hub-ui/field/input'
import { PageHeader } from '@bottega/hub-ui/page-header'
import { toast } from '@bottega/hub-ui/toast'
import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { PLATFORM_SLUG } from '../../../../shared/brand.ts'
export const Route = createFileRoute('/notes')({ component: NotesPage })

function NotesPage() {
  return isHostedMode() ? <HostedNotesPage /> : <LocalNotesPage />
}

function NoteStatus({
  promotedTask,
  staleAt,
  staleReason,
}: {
  promotedTask: string | null
  staleAt: string | null
  staleReason?: string | null
}) {
  if (promotedTask) return <Badge identifier>{promotedTask}</Badge>
  if (staleAt) return <Badge tone="error">stale</Badge>
  return (
    <span className="flex flex-col items-start gap-1">
      <Badge>open</Badge>
      {staleReason ? (
        <span className="text-xs text-text-muted">anchor gone: {staleReason}</span>
      ) : null}
    </span>
  )
}

const canPromote = (note: { promoted_task: string | null; stale_at: string | null }) =>
  !note.promoted_task && !note.stale_at

function noteEmptyTitle(pending: boolean, stale: boolean) {
  if (pending) return 'Loading notes...'
  return stale ? 'No stale notes.' : 'No open notes.'
}

function NotesError({ error }: { error: { message: string } | null }) {
  return error ? <ErrorState title="Could not load notes" message={error.message} /> : null
}

type PromoteTarget = { record_id: string; label: string }

/**
 * A promoted task's title states the point, so it is asked for here rather than built from the
 * note text, which becomes the task body with its sightings.
 */
function PromoteNoteDialog({ note, onClose }: { note: PromoteTarget | null; onClose: () => void }) {
  const [title, setTitle] = useState('')
  const promote = useMutation(
    trpc.note.promote.mutationOptions({
      onSuccess: async (promoted) => {
        toast.success(`Promoted to ${promoted.promoted_task}`)
        await queryClient.invalidateQueries({ queryKey: trpc.note.list.queryKey() })
        onClose()
      },
      onError: (error) => toast.error(error.message),
    }),
  )
  const trimmed = title.trim()
  return (
    <Dialog
      open={note !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title="Promote note"
      description={
        note
          ? `${note.label} becomes a task: the title states the point, and the note text and its sightings become the body.`
          : undefined
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (note && trimmed) promote.mutate({ id: note.record_id, title: trimmed })
        }}
      >
        <label htmlFor="promote-title" className="block space-y-1">
          <span>Title</span>
          <Input
            id="promote-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <Button variant="primary" type="submit" disabled={!trimmed || promote.isPending}>
          {promote.isPending ? 'Promoting...' : 'Promote'}
        </Button>
      </form>
    </Dialog>
  )
}

function LocalNotesPage() {
  const [stale, setStale] = useState(false)
  const [promoting, setPromoting] = useState<PromoteTarget | null>(null)
  const notes = useQuery(trpc.note.list.queryOptions({ stale }, { refetchInterval: 2_000 }))
  const staleFilter = (
    <label htmlFor="show-stale" className="flex items-center gap-2 text-sm text-text-muted">
      <Checkbox
        id="show-stale"
        checked={stale}
        onChange={(event) => setStale(event.target.checked)}
      />
      Show stale only
    </label>
  )
  type Note = NonNullable<typeof notes.data>[number]
  const columns: CollectionColumn<Note>[] = [
    {
      id: 'note',
      label: 'Note',
      phone: 'title',
      render: (note) => <div className="max-w-xl whitespace-pre-wrap">{note.text}</div>,
      phoneRender: (note) => <span className="whitespace-pre-wrap">{note.text}</span>,
    },
    {
      id: 'seen',
      label: 'Seen',
      phone: 'line',
      render: (note) => `${note.label} · ${note.last_seen_at.slice(0, 16).replace('T', ' ')}`,
    },
    { id: 'project', label: 'Project', phone: 'line', render: (note) => note.project },
    { id: 'area', label: 'Area', phone: 'line', render: (note) => note.area ?? '-' },
    {
      id: 'sightings',
      label: 'Sightings',
      phone: 'more',
      render: (note) => note.sightings,
    },
    {
      id: 'status',
      label: 'Status',
      phone: 'aside',
      render: (note) => (
        <NoteStatus
          promotedTask={note.promoted_task}
          staleAt={note.stale_at}
          staleReason={note.stale_reason}
        />
      ),
    },
  ]
  return (
    <section>
      <PageHeader title="Notes" about="The suggestion box" />
      <NotesError error={notes.error} />
      <Collection
        title="Notes"
        count={notes.data?.length ?? 0}
        filters={staleFilter}
        filtersActive={stale ? 1 : 0}
        columns={columns}
        rows={notes.data ?? []}
        getKey={(note) => note.record_id}
        onOpen={() => undefined}
        rowActions={(note) =>
          canPromote(note) ? (
            <Button size="sm" variant="secondary" onClick={() => setPromoting(note)}>
              Promote
            </Button>
          ) : null
        }
        empty={{
          title: noteEmptyTitle(notes.isPending, stale),
          hint: notes.isPending ? undefined : `File one with ${PLATFORM_SLUG} note new.`,
        }}
      />
      <PromoteNoteDialog
        key={promoting?.record_id ?? 'none'}
        note={promoting}
        onClose={() => setPromoting(null)}
      />
    </section>
  )
}

export function HostedNotesPage() {
  const [stale, setStale] = useState(false)
  const query = useQuery(trpc.record.notes.queryOptions({ stale }, { refetchInterval: 10_000 }))
  const acknowledgements = query.data?.acknowledgements ?? []
  const staleFilter = (
    <label htmlFor="show-stale" className="flex items-center gap-2 text-sm text-text-muted">
      <Checkbox
        id="show-stale"
        checked={stale}
        onChange={(event) => setStale(event.target.checked)}
      />
      Show stale only
    </label>
  )
  type Note = NonNullable<typeof query.data>['notes'][number]
  const columns: CollectionColumn<Note>[] = [
    {
      id: 'note',
      label: 'Note',
      phone: 'title',
      render: (note) => (
        <div className="max-w-xl whitespace-pre-wrap">
          <div>{note.text}</div>
          {note.anchors.length ? (
            <div className="mt-1 text-xs text-text-muted">
              {note.anchors
                .map(
                  (anchor) =>
                    anchor.files.map((file) => `${file.path}:${file.line}`).join(', ') ||
                    anchor.cwd,
                )
                .join(' · ')}
            </div>
          ) : null}
          {note.stale_reason ? (
            <div className="mt-1 text-xs text-text-muted">{note.stale_reason}</div>
          ) : null}
        </div>
      ),
      phoneRender: (note) => <span className="whitespace-pre-wrap">{note.text}</span>,
    },
    {
      id: 'seen',
      label: 'Seen',
      phone: 'line',
      render: (note) => `${note.label} · ${note.last_seen_at.slice(0, 16).replace('T', ' ')}`,
    },
    { id: 'space', label: 'Space', phone: 'line', render: (note) => note.space_name },
    { id: 'project', label: 'Project', phone: 'line', render: (note) => note.project },
    { id: 'area', label: 'Area', phone: 'line', render: (note) => note.area ?? '-' },
    {
      id: 'sightings',
      label: 'Sightings',
      phone: 'more',
      render: (note) => note.sightings,
    },
    {
      id: 'status',
      label: 'Status',
      phone: 'aside',
      render: (note) => <NoteStatus promotedTask={note.promoted_task} staleAt={note.stale_at} />,
    },
    {
      id: 'acknowledgements',
      label: 'Acknowledgements',
      phone: 'more',
      render: (note) => {
        const noteAcks = acknowledgements.filter(
          (ack) => ack.space_id === note.space_id && ack.note_id === note.id,
        )
        return noteAcks.length
          ? noteAcks.map((ack) => `${ack.session_id} (${ack.sightings})`).join(', ')
          : '-'
      },
    },
  ]
  return (
    <section>
      <PageHeader title="Notes" about="The suggestion box · read only" />
      <NotesError error={query.error} />
      <Collection
        title="Notes"
        count={query.data?.notes.length ?? 0}
        filters={staleFilter}
        filtersActive={stale ? 1 : 0}
        columns={columns}
        rows={query.data?.notes ?? []}
        getKey={(note) => `${note.space_id}:${note.id}`}
        onOpen={() => undefined}
        empty={{
          title: noteEmptyTitle(query.isPending, stale),
          hint: query.isPending ? undefined : 'No notes are recorded for this space.',
        }}
      />
    </section>
  )
}
