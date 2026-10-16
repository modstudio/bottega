import { Button } from '@bottega/hub-ui/button'
import { Dialog } from '@bottega/hub-ui/dialog'
import { Input } from '@bottega/hub-ui/field/input'
import { Select } from '@bottega/hub-ui/listbox/select'
import { useEffect, useState } from 'react'
import { DOC_SCOPE_SUBJECT_KIND, DOC_SCOPES, type DocScope } from '../../../../shared/docs.ts'
import { DOC_DELIVERY_LABELS } from './filters.ts'
import { isScope } from './scope.ts'

function needsSubject(scope: DocScope) {
  return DOC_SCOPE_SUBJECT_KIND[scope] !== null
}

const deliveryOptions = (['inject', 'demand'] as const).map((value) => ({
  value,
  label: DOC_DELIVERY_LABELS[value],
}))

export function CreateDocDialog({
  open,
  onOpenChange,
  subjects,
  create,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  subjects:
    | Partial<Record<(typeof DOC_SCOPE_SUBJECT_KIND)[DocScope] & string, string[]>>
    | undefined
  create: {
    run: (input: {
      scope: DocScope
      subject: string | null
      slug: string
      title: string
      body: string
      reason: string
      delivery: 'inject' | 'demand'
    }) => Promise<unknown>
    pending: boolean
    error: unknown
    refused?: string
  }
  onCreated: (address: {
    scope: DocScope
    subject: string | null
    slug: string
  }) => Promise<void>
}) {
  const [scope, setScope] = useState<DocScope>('global')
  const [subject, setSubject] = useState('')
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState('')
  const [delivery, setDelivery] = useState<'inject' | 'demand'>('inject')

  const subjectKind = DOC_SCOPE_SUBJECT_KIND[scope]
  const subjectOptions = subjectKind === null ? [] : (subjects?.[subjectKind] ?? [])

  useEffect(() => {
    if (!needsSubject(scope)) {
      setSubject('')
      return
    }
    if (subject && subjectOptions.includes(subject)) return
    setSubject(subjectOptions[0] ?? '')
  }, [scope, subject, subjectOptions])

  async function submitCreate() {
    if (!slug || !title) return
    if (needsSubject(scope) && !subject) return
    const address = {
      scope,
      subject: needsSubject(scope) ? subject : null,
      slug,
    }
    if (create.refused) return
    const created = await create.run({
      ...address,
      title,
      body: '',
      reason: 'created from hub',
      delivery,
    })
    if (!created) return
    onOpenChange(false)
    await onCreated(address)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New doc"
      description="Creates an empty body and opens it for editing."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            onClick={submitCreate}
            disabled={
              create.pending ||
              Boolean(create.refused) ||
              !slug ||
              !title ||
              (needsSubject(scope) && !subject)
            }
          >
            Create
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-1 text-sm">
          <span className="text-text-muted">Scope</span>
          <Select
            label="Scope"
            value={scope}
            options={DOC_SCOPES.map((value) => ({ value, label: value }))}
            onChange={(next) => {
              if (isScope(next)) setScope(next)
            }}
          />
        </div>
        {needsSubject(scope) ? (
          <div className="grid gap-1 text-sm">
            <span className="text-text-muted">Subject</span>
            <Select
              label="Subject"
              value={subject}
              options={subjectOptions.map((name) => ({ value: name, label: name }))}
              onChange={setSubject}
            />
          </div>
        ) : null}
        <label htmlFor="new-doc-slug" className="block text-sm">
          <span className="text-text-muted">Slug</span>
          <Input id="new-doc-slug" value={slug} onChange={(e) => setSlug(e.target.value)} />
        </label>
        <label htmlFor="new-doc-title" className="block text-sm">
          <span className="text-text-muted">Title</span>
          <Input id="new-doc-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="grid gap-1 text-sm">
          <span className="text-text-muted">Delivery</span>
          <Select
            label="Delivery"
            value={delivery}
            options={deliveryOptions}
            onChange={(next) => setDelivery(next as 'inject' | 'demand')}
          />
        </div>
        {create.error || create.refused ? (
          <p data-tone="error" className="text-status-text">
            {create.refused ??
              (create.error instanceof Error ? create.error.message : String(create.error))}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
