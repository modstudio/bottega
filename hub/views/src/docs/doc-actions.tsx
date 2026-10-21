import { Button } from '@bottega/hub-ui/button'
import { Dialog } from '@bottega/hub-ui/dialog'
import { Input } from '@bottega/hub-ui/field/input'
import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { docActionsStyles } from './doc-actions.styles.ts'
import { isDocReasonReady } from './edit-state.ts'

/** What an editor can do to the article as a whole, apart from editing its fields. */
export function DocActions({
  remove,
}: {
  remove: {
    run: (reason: string) => Promise<unknown>
    pending: boolean
    error: unknown
    refused?: string
  }
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const canSubmit = isDocReasonReady(reason) && !remove.refused && !remove.pending

  function submit() {
    if (!canSubmit) return
    void remove.run(reason)
  }

  return (
    <>
      <div>
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
        <label htmlFor="doc-delete-reason" className={docActionsStyles().deleteReasonField()}>
          <span className={docActionsStyles().deleteReasonLabel()}>Reason</span>
          <Input
            id="doc-delete-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {remove.error || remove.refused ? (
          <p data-tone="error" className={docActionsStyles().deleteError()}>
            {remove.refused ??
              (remove.error instanceof Error ? remove.error.message : String(remove.error))}
          </p>
        ) : null}
      </Dialog>
    </>
  )
}
