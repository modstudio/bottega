import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Trash2, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { queryClient, trpc } from '@/trpc/client'
import { Button } from '@/ui/button/button'
import { Checkbox } from '@/ui/checkbox/checkbox'
import { Dialog } from '@/ui/dialog/dialog'
import { Input } from '@/ui/field/input'
import { Select } from '@/ui/listbox/select'
import {
  DOC_AUDIENCES,
  DOC_FORMS,
  type DocArticleSubject,
  type DocForm,
} from '../../../../shared/docs.ts'
import { isDocReasonReady } from './edit-state.ts'
import {
  DOC_AUDIENCE_LABELS,
  DOC_DELIVERY_LABELS,
  DOC_FORM_LABELS,
  DOC_STATUS_LABELS,
} from './filters.ts'
import {
  articleSubjectChoices,
  type DocFieldChange,
  fieldWriteInput,
  parentChoices,
  toggledAudiences,
} from './manage-fields.ts'
import { isScope } from './scope.ts'
import type { DocsDoc, DocsSource } from './types.ts'
import { useDocsTree, useStoredDocument } from './use-docs.ts'

const eyebrow = 'font-mono text-text-muted text-xs tracking-[0.14em] uppercase'

function ManageRow({
  label,
  children,
  error,
}: {
  label: string
  children: ReactNode
  error?: string
}) {
  return (
    <div className="grid gap-1.5">
      <span className="text-text-muted">{label}</span>
      <div>{children}</div>
      {error ? (
        <p data-tone="error" className="m-0 text-sm text-status-text">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function SelectedSubjects({
  choices,
  selected,
  ownSubjectId,
  disabled,
  onChange,
}: {
  choices: readonly DocArticleSubject[]
  selected: readonly DocArticleSubject[]
  ownSubjectId?: string
  disabled: boolean
  onChange: (choices: DocArticleSubject[]) => void
}) {
  const selectedIds = new Set(selected.map(({ id }) => id))
  return (
    <div className="grid gap-1.5">
      {choices
        .filter(({ id }) => id !== ownSubjectId)
        .map((choice) => (
          <label
            key={choice.id}
            htmlFor={`related-subject-${choice.id}`}
            className="flex items-center gap-2 text-text-secondary"
          >
            <Checkbox
              id={`related-subject-${choice.id}`}
              checked={selectedIds.has(choice.id)}
              disabled={disabled}
              onChange={() => {
                const next = selectedIds.has(choice.id)
                  ? selected.filter(({ id }) => id !== choice.id)
                  : [...selected, choice]
                onChange([...next].sort((left, right) => left.name.localeCompare(right.name)))
              }}
            />
            <span>{choice.name}</span>
          </label>
        ))}
    </div>
  )
}

type FieldsViewProps = {
  doc: DocsDoc
  choices: ReturnType<typeof parentChoices>
  parentTitle: string
  subjects: DocArticleSubject[]
  textOnly: boolean
  subjectTextOnly: boolean
  revisionReady: boolean
  sourceFile: string
  setSourceFile: (value: string) => void
  save: (change: DocFieldChange) => void
  isSaving: (field: DocFieldChange['field']) => boolean
  message: (field: DocFieldChange['field']) => string | undefined
}

function CoreFields(props: FieldsViewProps) {
  const { doc, choices, parentTitle, textOnly, revisionReady, save, isSaving, message } = props
  return (
    <>
      <ManageRow label="Status" error={message('status')}>
        {textOnly || doc.status === 'superseded' || doc.status === 'archived' ? (
          <span className="text-text-secondary">{DOC_STATUS_LABELS[doc.status]}</span>
        ) : (
          <fieldset disabled={!revisionReady || isSaving('status')}>
            <Select
              className="w-full"
              label="Status"
              value={doc.status}
              options={(['draft', 'current'] as const).map((value) => ({
                value,
                label: DOC_STATUS_LABELS[value],
              }))}
              onChange={(value) => save({ field: 'status', value: value as 'draft' | 'current' })}
            />
          </fieldset>
        )}
      </ManageRow>
      <ManageRow label="Parent" error={message('parent')}>
        {textOnly ? (
          <span className="text-text-secondary">{parentTitle}</span>
        ) : (
          <fieldset disabled={!revisionReady || isSaving('parent')}>
            <Select
              className="w-full"
              label="Parent"
              value={doc.parentId ?? ''}
              options={[
                { value: '', label: 'Top level' },
                ...choices.map((item) => ({ value: item.id, label: item.title })),
              ]}
              onChange={(id) =>
                save({ field: 'parent', value: choices.find((item) => item.id === id) ?? null })
              }
            />
          </fieldset>
        )}
      </ManageRow>
      <ManageRow label="Audience" error={message('audiences')}>
        {textOnly ? (
          <span className="text-text-secondary">
            {doc.audiences.map((audience) => DOC_AUDIENCE_LABELS[audience]).join(', ')}
          </span>
        ) : (
          <div className="grid gap-1.5">
            {DOC_AUDIENCES.map((audience) => (
              <label
                key={audience}
                htmlFor={`doc-audience-${audience}`}
                className="flex items-center gap-2 text-text-secondary"
              >
                <Checkbox
                  id={`doc-audience-${audience}`}
                  checked={doc.audiences.includes(audience)}
                  disabled={!revisionReady || isSaving('audiences')}
                  onChange={() => {
                    const value = toggledAudiences(doc.audiences, audience)
                    if (value) save({ field: 'audiences', value })
                  }}
                />
                <span>{DOC_AUDIENCE_LABELS[audience]}</span>
              </label>
            ))}
          </div>
        )}
      </ManageRow>
    </>
  )
}

function ArticleClassification(props: FieldsViewProps) {
  const { doc, subjects, textOnly, subjectTextOnly, revisionReady, save, isSaving, message } = props
  const subjectChoices = articleSubjectChoices(subjects, doc.relatedSubjects ?? [])
  return (
    <>
      <ManageRow label="Type" error={message('form')}>
        {textOnly ? (
          <span className="text-text-secondary">
            {doc.form ? DOC_FORM_LABELS[doc.form] : 'None'}
          </span>
        ) : (
          <fieldset disabled={!revisionReady || isSaving('form')}>
            <Select
              className="w-full"
              label="Type"
              value={doc.form ?? ''}
              options={[
                { value: '', label: 'None' },
                ...DOC_FORMS.map((form) => ({ value: form, label: DOC_FORM_LABELS[form] })),
              ]}
              onChange={(value) =>
                save({ field: 'form', value: (value || null) as DocForm | null })
              }
            />
          </fieldset>
        )}
      </ManageRow>
      <ManageRow label="Subject" error={message('articleSubject')}>
        {subjectTextOnly ? (
          <span className="text-text-secondary">{doc.articleSubject?.name ?? 'None'}</span>
        ) : (
          <fieldset disabled={!revisionReady || isSaving('articleSubject')}>
            <Select
              className="w-full"
              label="Subject"
              value={doc.articleSubject?.id ?? ''}
              options={[
                { value: '', label: 'None' },
                ...subjectChoices.map(({ id, name }) => ({ value: id, label: name })),
              ]}
              onChange={(id) =>
                save({
                  field: 'articleSubject',
                  value: subjectChoices.find((item) => item.id === id) ?? null,
                })
              }
            />
          </fieldset>
        )}
      </ManageRow>
      <ManageRow label="Related subjects" error={message('relatedSubjects')}>
        {subjectTextOnly ? (
          <span className="text-text-secondary">
            {doc.relatedSubjects?.map(({ name }) => name).join(', ') || 'None'}
          </span>
        ) : (
          <SelectedSubjects
            choices={subjects}
            selected={doc.relatedSubjects ?? []}
            ownSubjectId={doc.articleSubject?.id}
            disabled={!revisionReady || isSaving('relatedSubjects')}
            onChange={(value) => save({ field: 'relatedSubjects', value })}
          />
        )}
      </ManageRow>
    </>
  )
}

function SourceFilesField(props: FieldsViewProps) {
  const { doc, textOnly, revisionReady, sourceFile, setSourceFile, save, isSaving, message } = props
  return (
    <ManageRow label="Source files" error={message('sourceFiles')}>
      <div className="grid gap-2">
        {(doc.sourceFiles ?? []).map((path) => (
          <div key={path} className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 break-all font-mono text-sm text-text-secondary">
              {path}
            </span>
            {!textOnly ? (
              <Button
                size="sm"
                disabled={!revisionReady || isSaving('sourceFiles')}
                aria-label={`Remove ${path}`}
                onClick={() =>
                  save({
                    field: 'sourceFiles',
                    value: (doc.sourceFiles ?? []).filter((value) => value !== path),
                    action: 'removed',
                    path,
                  })
                }
              >
                <X size={14} />
              </Button>
            ) : null}
          </div>
        ))}
        {!textOnly ? (
          <div className="flex items-center gap-2">
            <Input
              size="sm"
              aria-label="Source file path"
              value={sourceFile}
              disabled={!revisionReady || isSaving('sourceFiles')}
              onChange={(event) => setSourceFile(event.target.value)}
            />
            <Button
              size="sm"
              disabled={!revisionReady || isSaving('sourceFiles') || !sourceFile.trim()}
              onClick={() => {
                const path = sourceFile.trim()
                save({
                  field: 'sourceFiles',
                  value: [...(doc.sourceFiles ?? []), path],
                  action: 'added',
                  path,
                })
                setSourceFile('')
              }}
            >
              Add
            </Button>
          </div>
        ) : null}
      </div>
    </ManageRow>
  )
}

function DeliveryField(props: FieldsViewProps) {
  const { doc, textOnly, revisionReady, save, isSaving, message } = props
  return (
    <ManageRow label="Delivery" error={message('delivery')}>
      {textOnly ? (
        <span className="text-text-secondary">{DOC_DELIVERY_LABELS[doc.delivery ?? 'inject']}</span>
      ) : (
        <fieldset disabled={!revisionReady || isSaving('delivery')}>
          <Select
            className="w-full"
            label="Delivery"
            value={doc.delivery ?? 'inject'}
            options={(['inject', 'demand'] as const).map((value) => ({
              value,
              label: DOC_DELIVERY_LABELS[value],
            }))}
            onChange={(value) => save({ field: 'delivery', value: value as 'inject' | 'demand' })}
          />
        </fieldset>
      )}
    </ManageRow>
  )
}

function FieldControls({ doc, source }: { doc: DocsDoc; source: DocsSource }) {
  const tree = useDocsTree(source)
  const storedDocument = useStoredDocument(doc, source, true)
  const [pendingFields, setPendingFields] = useState<Set<DocFieldChange['field']>>(() => new Set())
  const [errors, setErrors] = useState<Partial<Record<DocFieldChange['field'], string>>>({})
  const [sourceFile, setSourceFile] = useState('')
  const project = doc.projectName ?? ''
  const canAddress = source === 'local' ? isScope(doc.scope) : Boolean(doc.spaceId)
  const canAddressSubjects = canAddress && Boolean(project)
  const localSubjects = useQuery({
    ...trpc.subject.list.queryOptions({ project }),
    enabled: source === 'local' && doc.kind === 'article' && canAddressSubjects,
  })
  const hostedSubjects = useQuery({
    ...trpc.record.subjects.queryOptions({
      spaceId: doc.spaceId ?? '00000000-0000-4000-8000-000000000000',
      project,
    }),
    enabled: source === 'hosted' && doc.kind === 'article' && canAddressSubjects,
  })
  const subjects: DocArticleSubject[] = (
    source === 'hosted' ? (hostedSubjects.data ?? []) : (localSubjects.data ?? [])
  ).map(({ id, name }) => ({ id, name }))
  const choices = parentChoices(doc, tree.items)
  const revisionReady = Boolean(storedDocument && (source === 'local' || storedDocument.revision))

  const settled = (field: DocFieldChange['field']) => {
    setPendingFields((current) => {
      const next = new Set(current)
      next.delete(field)
      return next
    })
  }
  const saved = async (field: DocFieldChange['field']) => {
    await queryClient.invalidateQueries()
    settled(field)
  }
  const failed = (field: DocFieldChange['field'], cause: unknown) => {
    setErrors((current) => ({
      ...current,
      [field]: cause instanceof Error ? cause.message : String(cause),
    }))
    settled(field)
  }
  const localSave = useMutation(trpc.doc.set.mutationOptions())
  const hostedSave = useMutation(trpc.record.saveDoc.mutationOptions())

  function save(change: DocFieldChange) {
    if (!canAddress || !storedDocument || (source === 'hosted' && !storedDocument.revision)) return
    setErrors((current) => ({ ...current, [change.field]: undefined }))
    setPendingFields((current) => new Set(current).add(change.field))
    const callbacks = {
      onSuccess: () => saved(change.field),
      onError: (cause: unknown) => failed(change.field, cause),
    }
    if (source === 'hosted') {
      if (!doc.spaceId || !storedDocument.revision) return
      hostedSave.mutate(
        fieldWriteInput(
          'hosted',
          { ...doc, spaceId: doc.spaceId },
          { ...storedDocument, revision: storedDocument.revision },
          change,
        ),
        callbacks,
      )
      return
    }
    localSave.mutate(fieldWriteInput('local', doc, storedDocument, change), callbacks)
  }

  const isSaving = (field: DocFieldChange['field']) => pendingFields.has(field)
  const message = (field: DocFieldChange['field']) => errors[field]
  const textOnly = !canAddress
  const subjectTextOnly = !canAddressSubjects

  const view = {
    doc,
    choices,
    parentTitle: tree.items.find(({ id }) => id === doc.parentId)?.title ?? 'Top level',
    subjects,
    textOnly,
    subjectTextOnly,
    revisionReady,
    sourceFile,
    setSourceFile,
    save,
    isSaving,
    message,
  }
  return (
    <div className="mt-2.5 grid gap-4 text-md">
      <CoreFields {...view} />
      {doc.kind === 'article' ? (
        <>
          <ArticleClassification {...view} />
          <SourceFilesField {...view} />
        </>
      ) : (
        <DeliveryField {...view} />
      )}
    </div>
  )
}

export function DocManage({ doc, source }: { doc: DocsDoc; source: DocsSource }) {
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
      <span className={eyebrow}>Manage</span>
      <FieldControls doc={doc} source={source} />
      <div className="mt-5 border-border-default border-t pt-3">
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
