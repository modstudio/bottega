import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { queryClient, trpc } from '@/trpc/client'
import { Button } from '@/ui/button/button'
import { Dialog } from '@/ui/dialog/dialog'
import { Input } from '@/ui/field/input'
import { Select } from '@/ui/listbox/select'
import { DOC_SCOPE_SUBJECT_KIND, DOC_SCOPES, type DocScope } from '../../../../shared/docs.ts'
import { isScope } from './scope.ts'

function needsSubject(scope: DocScope) {
  return DOC_SCOPE_SUBJECT_KIND[scope] !== null
}

const deliveryOptions = [
  { value: 'inject', label: 'Inject' },
  { value: 'demand', label: 'Demand' },
]

export function CreateDocDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const subjects = useQuery({ ...trpc.doc.subjects.queryOptions(), enabled: open })
  const [scope, setScope] = useState<DocScope>('global')
  const [subject, setSubject] = useState('')
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState('')
  const [delivery, setDelivery] = useState<'inject' | 'demand'>('inject')

  const create = useMutation({
    ...trpc.doc.set.mutationOptions(),
    onSuccess: async (_row, input) => {
      await queryClient.invalidateQueries()
      onOpenChange(false)
      await navigate({
        to: '/docs/$scope/$subject/$slug',
        params: {
          scope: input.scope,
          subject: input.subject ?? '_',
          slug: input.slug,
        },
        search: { edit: true },
      })
    },
  })

  const subjectKind = DOC_SCOPE_SUBJECT_KIND[scope]
  const subjectOptions = subjectKind === null ? [] : (subjects.data?.[subjectKind] ?? [])

  useEffect(() => {
    if (!needsSubject(scope)) {
      setSubject('')
      return
    }
    if (subject && subjectOptions.includes(subject)) return
    setSubject(subjectOptions[0] ?? '')
  }, [scope, subject, subjectOptions])

  function submitCreate() {
    if (!slug || !title) return
    if (needsSubject(scope) && !subject) return
    create.mutate({
      scope,
      subject: needsSubject(scope) ? subject : null,
      slug,
      title,
      body: '',
      reason: 'created from hub',
      delivery,
    })
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
            disabled={create.isPending || !slug || !title || (needsSubject(scope) && !subject)}
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
        {create.error ? (
          <p data-tone="error" className="text-status-text">
            {create.error.message}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
