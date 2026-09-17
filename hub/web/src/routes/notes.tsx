import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { isHostedMode } from '@/lib/hub-mode'
import { queryClient, trpc } from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { Button } from '@/ui/button/button'
import { Checkbox } from '@/ui/checkbox/checkbox'
import { EmptyState } from '@/ui/empty-state/empty-state'
import { PageHeader } from '@/ui/page-header/page-header'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table/table'
import { toast } from '@/ui/toast/toast'

export const Route = createFileRoute('/notes')({ component: NotesPage })

function NotesPage() {
  return isHostedMode() ? <HostedNotesPage /> : <LocalNotesPage />
}

function LocalNotesPage() {
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
  return (
    <section>
      <PageHeader
        title="Notes"
        subtitle="The suggestion box"
        actions={
          <label htmlFor="show-stale" className="flex items-center gap-2 text-sm text-text-muted">
            <Checkbox
              id="show-stale"
              checked={stale}
              onChange={(event) => setStale(event.target.checked)}
            />
            Show stale only
          </label>
        }
      />
      {notes.error ? (
        <p data-tone="error" className="text-status-text">
          {notes.error.message}
        </p>
      ) : null}
      {notes.data?.length ? (
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
                <TableRow key={note.id}>
                  <TableCell>
                    <div className="max-w-xl whitespace-pre-wrap">{note.text}</div>
                    <div className="mt-1 text-xs text-text-muted">
                      #{note.id} · {note.last_seen_at.slice(0, 16).replace('T', ' ')}
                    </div>
                  </TableCell>
                  <TableCell>{note.project}</TableCell>
                  <TableCell>{note.area ?? '-'}</TableCell>
                  <TableCell>{note.sightings}</TableCell>
                  <TableCell>
                    {note.promoted_task ? (
                      <Badge identifier>{note.promoted_task}</Badge>
                    ) : note.stale_at ? (
                      <Badge tone="error">stale</Badge>
                    ) : (
                      <Badge>open</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {!note.promoted_task && !note.stale_at ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={promote.isPending}
                        onClick={() => promote.mutate({ id: note.id })}
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
          hint="File one with orch note."
        />
      )}
    </section>
  )
}

export function HostedNotesPage() {
  const [stale, setStale] = useState(false)
  const query = useQuery(trpc.record.notes.queryOptions({ stale }, { refetchInterval: 10_000 }))
  const acknowledgements = query.data?.acknowledgements ?? []
  return (
    <section>
      <PageHeader
        title="Notes"
        subtitle="The suggestion box · read only"
        actions={
          <label htmlFor="show-stale" className="flex items-center gap-2 text-sm text-text-muted">
            <Checkbox id="show-stale" checked={stale} onChange={(event) => setStale(event.target.checked)} />
            Show stale only
          </label>
        }
      />
      {query.error ? <p data-tone="error" className="text-status-text">{query.error.message}</p> : null}
      {query.data?.notes.length ? (
        <div className="border border-border-default">
          <Table>
            <TableHeader><TableRow><TableHead>Note</TableHead><TableHead>Project</TableHead><TableHead>Area</TableHead><TableHead>Sightings</TableHead><TableHead>Status</TableHead><TableHead>Acknowledgements</TableHead></TableRow></TableHeader>
            <TableBody>
              {query.data.notes.map((note) => {
                const noteAcks = acknowledgements.filter((ack) => ack.note_id === note.id)
                return (
                  <TableRow key={note.id}>
                    <TableCell>
                      <div className="max-w-xl whitespace-pre-wrap">{note.text}</div>
                      <div className="mt-1 text-xs text-text-muted">#{note.id} · {note.last_seen_at.slice(0, 16).replace('T', ' ')}</div>
                      {note.anchors.length ? <div className="mt-1 text-xs text-text-muted">{note.anchors.map((anchor) => anchor.files.map((file) => `${file.path}:${file.line}`).join(', ') || anchor.cwd).join(' · ')}</div> : null}
                      {note.stale_reason ? <div className="mt-1 text-xs text-text-muted">{note.stale_reason}</div> : null}
                    </TableCell>
                    <TableCell>{note.project}</TableCell><TableCell>{note.area ?? '-'}</TableCell><TableCell>{note.sightings}</TableCell>
                    <TableCell>{note.promoted_task ? <Badge identifier>{note.promoted_task}</Badge> : note.stale_at ? <Badge tone="error">stale</Badge> : <Badge>open</Badge>}</TableCell>
                    <TableCell>{noteAcks.length ? noteAcks.map((ack) => `${ack.session_id} (${ack.sightings})`).join(', ') : '-'}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      ) : query.isPending ? <p className="text-text-muted">Loading notes...</p> : <EmptyState title={stale ? 'No stale notes.' : 'No open notes.'} hint="No notes are recorded for this space." />}
    </section>
  )
}
