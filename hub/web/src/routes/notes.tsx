import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Badge } from '@/components/badge'
import { Button } from '@/components/button'
import { Checkbox } from '@/components/checkbox'
import { EmptyState, PageHeader } from '@/components/design-system'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/table'
import { toast } from '@/components/toaster'
import { queryClient, trpc } from '@/trpc/client'

export const Route = createFileRoute('/notes')({ component: NotesPage })

function NotesPage() {
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
          <label
            htmlFor="show-stale"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Checkbox
              id="show-stale"
              checked={stale}
              onChange={(event) => setStale(event.target.checked)}
            />
            Show stale only
          </label>
        }
      />
      {notes.error ? <p className="text-destructive">{notes.error.message}</p> : null}
      {notes.data?.length ? (
        <div className="border border-border">
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
                    <div className="mt-1 text-xs text-muted-foreground">
                      #{note.id} · {note.last_seen_at.slice(0, 16).replace('T', ' ')}
                    </div>
                  </TableCell>
                  <TableCell>{note.project}</TableCell>
                  <TableCell>{note.area ?? '-'}</TableCell>
                  <TableCell>{note.sightings}</TableCell>
                  <TableCell>
                    {note.promoted_task ? (
                      <Badge variant="outline">{note.promoted_task}</Badge>
                    ) : note.stale_at ? (
                      <Badge variant="danger">stale</Badge>
                    ) : (
                      <Badge variant="outline">open</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {!note.promoted_task && !note.stale_at ? (
                      <Button
                        size="sm"
                        variant="outline"
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
        <p className="text-muted-foreground">Loading notes...</p>
      ) : (
        <EmptyState
          title={stale ? 'No stale notes.' : 'No open notes.'}
          hint="File one with orch note."
        />
      )}
    </section>
  )
}
