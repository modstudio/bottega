import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { queryClient, trpc } from '@/trpc/client'
import { Button } from '@/ui/button/button'
import { Dialog } from '@/ui/dialog/dialog'
import { Input } from '@/ui/field/input'
import { isDocReasonReady } from './edit-state.ts'
import { isScope } from './scope.ts'
import type { DocsDoc, DocsSource } from './types.ts'
import { useStoredDocument } from './use-docs.ts'

const eyebrow = 'font-mono text-text-muted text-xs tracking-[0.14em] uppercase'

/** What an editor can do to the article as a whole, apart from editing its fields. */
export function DocActions({ doc, source }: { doc: DocsDoc; source: DocsSource }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const storedDocument = useStoredDocument(doc, source, open)
  const expectedRevision = storedDocument?.revision
  const hostedRevisionMissing = source === 'hosted' && !expectedRevision

  async function removed() {
    await queryClient.invalidateQueries()
    await navigate({ to: '/docs' })
  }
  const localRemove = useMutation({ ...trpc.doc.remove.mutationOptions(), onSuccess: removed })
  const hostedRemove = useMutation({
    ...trpc.record.deleteDoc.mutationOptions(),
    onSuccess: removed,
  })
  const removeState = source === 'hosted' ? hostedRemove : localRemove
  const canSubmit = isDocReasonReady(reason) && !hostedRevisionMissing && !removeState.isPending

  function submit() {
    if (!canSubmit) return
    if (source === 'hosted') {
      if (!doc.spaceId || !expectedRevision) return
      hostedRemove.mutate({
        id: doc.id,
        spaceId: doc.spaceId,
        reason: reason.trim(),
        expectedRevision,
      })
      return
    }
    if (!isScope(doc.scope)) return
    localRemove.mutate({
      scope: doc.scope,
      subject: doc.subject,
      slug: doc.slug,
      reason: reason.trim(),
      expectedRevision: expectedRevision ?? undefined,
    })
  }

  return (
    <section className="mt-7 border-border-default border-t pt-3">
      <span className={eyebrow}>Actions</span>
      <div className="mt-2.5">
        <Button
          size="sm"
          variant="danger"
          onClick={() => {
            setReason('')
            setOpen(true)
          }}
        >
          <Trash2 size={14} />
          Delete article
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Delete article?"
        description="This removes the article. Give a reason to continue."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="danger" disabled={!canSubmit} onClick={submit}>
              Delete article
            </Button>
          </>
        }
      >
        <label htmlFor="doc-delete-reason" className="grid gap-1 text-sm">
          <span className="text-text-muted">Reason</span>
          <Input
            id="doc-delete-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {removeState.error ? (
          <p data-tone="error" className="mt-2 text-sm text-status-text">
            {removeState.error.message}
          </p>
        ) : null}
      </Dialog>
    </section>
  )
}
