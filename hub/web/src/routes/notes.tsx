import { queryClient, trpc } from '@bottega/hub-data/client'
import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { Badge } from '@bottega/hub-ui/badge'
import { Button } from '@bottega/hub-ui/button'
import { Checkbox } from '@bottega/hub-ui/checkbox'
import { Collection, type CollectionColumn } from '@bottega/hub-ui/collection'
import { PHONE_QUERY, useMediaQuery } from '@bottega/hub-ui/dom/use-media-query'
import { EmptyState } from '@bottega/hub-ui/empty-state'
import { PageHeader } from '@bottega/hub-ui/page-header'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@bottega/hub-ui/table'
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
}: {
  promotedTask: string | null
  staleAt: string | null
}) {
  if (promotedTask) return <Badge identifier>{promotedTask}</Badge>
  if (staleAt) return <Badge tone="error">stale</Badge>
  return <Badge>open</Badge>
}

const canPromote = (note: { promoted_task: string | null; stale_at: string | null }) =>
  !note.promoted_task && !note.stale_at

function noteEmptyTitle(pending: boolean, stale: boolean) {
  if (pending) return 'Loading notes...'
  return stale ? 'No stale notes.' : 'No open notes.'
}

function NotesError({ error }: { error: { message: string } | null }) {
  return error ? (
    <p data-tone="error" className="text-status-text">
      {error.message}
    </p>
  ) : null
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: phone and unchanged desk renderings stay together.
function LocalNotesPage() {
  const phone = useMediaQuery(PHONE_QUERY)
  const [stale, setStale] = useState(false)
  const notes = useQuery(trpc.note.list.queryOptions({ stale }, { refetchInterval: 2_000 }))
  const promote = useMutation(
    trpc.note.promote.mutationOptions({
      onSuccess: async (note) => {
        toast.success(`Promoted to ${note.promoted_task}`)
        await queryClient.invalidateQueries({ queryKey: trpc.note.list.queryKey() })
      },
      onError: (error) => toast.error(error.message),
    }),
  )
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
      render: (note) => <NoteStatus promotedTask={note.promoted_task} staleAt={note.stale_at} />,
    },
  ]
  return (
    <section>
      <PageHeader
        title="Notes"
        subtitle="The suggestion box"
        actions={phone ? undefined : staleFilter}
      />
      <NotesError error={notes.error} />
      {phone ? (
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
              <Button
                size="sm"
                variant="secondary"
                disabled={promote.isPending}
                onClick={() => promote.mutate({ id: note.record_id })}
              >
                Promote
              </Button>
            ) : null
          }
          empty={{
            title: noteEmptyTitle(notes.isPending, stale),
            hint: notes.isPending ? undefined : `File one with ${PLATFORM_SLUG} note new.`,
          }}
        />
      ) : notes.data?.length ? (
        <div className="border border-border-default">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Note</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Area</TableHead>
                <TableHead>Sightings</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {notes.data.map((note) => (
                <TableRow key={note.record_id}>
                  <TableCell>
                    <div className="max-w-xl whitespace-pre-wrap">{note.text}</div>
                    <div className="mt-1 text-xs text-text-muted">
                      {note.label} · {note.last_seen_at.slice(0, 16).replace('T', ' ')}
                    </div>
                  </TableCell>
                  <TableCell>{note.project}</TableCell>
                  <TableCell>{note.area ?? '-'}</TableCell>
                  <TableCell>{note.sightings}</TableCell>
                  <TableCell>
                    <NoteStatus promotedTask={note.promoted_task} staleAt={note.stale_at} />
                  </TableCell>
                  <TableCell>
                    {canPromote(note) ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={promote.isPending}
                        onClick={() => promote.mutate({ id: note.record_id })}
                      >
                        Promote
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : notes.isPending ? (
        <p className="text-text-muted">Loading notes...</p>
      ) : (
        <EmptyState
          title={stale ? 'No stale notes.' : 'No open notes.'}
          hint={`File one with ${PLATFORM_SLUG} note new.`}
        />
      )}
    </section>
  )
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: phone and unchanged desk renderings stay together.
export function HostedNotesPage() {
  const phone = useMediaQuery(PHONE_QUERY)
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
      render: (note) => <div className="max-w-xl whitespace-pre-wrap">{note.text}</div>,
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
      <PageHeader
        title="Notes"
        subtitle="The suggestion box · read only"
        actions={phone ? undefined : staleFilter}
      />
      <NotesError error={query.error} />
      {phone ? (
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
      ) : query.data?.notes.length ? (
        <div className="border border-border-default">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Note</TableHead>
                <TableHead>Space</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Area</TableHead>
                <TableHead>Sightings</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Acknowledgements</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.notes.map((note) => {
                const noteAcks = acknowledgements.filter(
                  (ack) => ack.space_id === note.space_id && ack.note_id === note.id,
                )
                return (
                  <TableRow key={`${note.space_id}:${note.id}`}>
                    <TableCell>
                      <div className="max-w-xl whitespace-pre-wrap">{note.text}</div>
                      <div className="mt-1 text-xs text-text-muted">
                        {note.label} · {note.last_seen_at.slice(0, 16).replace('T', ' ')}
                      </div>
                      {note.anchors.length ? (
                        <div className="mt-1 text-xs text-text-muted">
                          {note.anchors
                            .map(
                              (anchor) =>
                                anchor.files
                                  .map((file) => `${file.path}:${file.line}`)
                                  .join(', ') || anchor.cwd,
                            )
                            .join(' · ')}
                        </div>
                      ) : null}
                      {note.stale_reason ? (
                        <div className="mt-1 text-xs text-text-muted">{note.stale_reason}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>{note.space_name}</TableCell>
                    <TableCell>{note.project}</TableCell>
                    <TableCell>{note.area ?? '-'}</TableCell>
                    <TableCell>{note.sightings}</TableCell>
                    <TableCell>
                      <NoteStatus promotedTask={note.promoted_task} staleAt={note.stale_at} />
                    </TableCell>
                    <TableCell>
                      {noteAcks.length
                        ? noteAcks.map((ack) => `${ack.session_id} (${ack.sightings})`).join(', ')
                        : '-'}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      ) : query.isPending ? (
        <p className="text-text-muted">Loading notes...</p>
      ) : (
        <EmptyState
          title={stale ? 'No stale notes.' : 'No open notes.'}
          hint="No notes are recorded for this space."
        />
      )}
    </section>
  )
}
