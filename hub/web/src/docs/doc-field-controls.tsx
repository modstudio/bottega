import { useMutation, useQuery } from '@tanstack/react-query'
import { ChevronDown, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { queryClient, trpc } from '@/trpc/client'
import { Badge } from '@bottega/hub-ui/badge'
import { Button } from '@bottega/hub-ui/button'
import { Checkbox } from '@bottega/hub-ui/checkbox'
import { Input } from '@bottega/hub-ui/field/input'
import { SearchSelect } from '@bottega/hub-ui/listbox/search-select'
import { Menu } from '@bottega/hub-ui/menu'
import { Popover } from '@bottega/hub-ui/popover'
import {
  DOC_AUDIENCES,
  DOC_FORMS,
  DOC_SUMMARY_MAX_LENGTH,
  type DocArticleSubject,
  type DocForm,
} from '../../../../shared/docs.ts'
import { CodeSection } from './code-section.tsx'
import {
  audiencesFrom,
  type DocFieldChange,
  fieldWriteInput,
  parentChoices,
  subjectsExcept,
  withCurrentSubjects,
} from './doc-field-changes.ts'
import {
  DOC_AUDIENCE_LABELS,
  DOC_DELIVERY_LABELS,
  DOC_FORM_LABELS,
  DOC_STATUS_LABELS,
} from './filters.ts'
import { isScope } from './scope.ts'
import { DOC_STATUS_ICONS } from './status-icon.ts'
import type { DocsDoc, DocsSource } from './types.ts'
import { useDocsTree, useStoredDocument } from './use-docs.ts'

type Field = DocFieldChange['field']

/**
 * Saves one field of a document at once, as its own revision carrying the stored title and body.
 * Each field keeps its own in-flight state and refusal, so controls can live wherever the field is
 * shown.
 */
function useDocFieldSave(doc: DocsDoc, source: DocsSource) {
  const storedDocument = useStoredDocument(doc, source, true)
  const [pending, setPending] = useState<Set<Field>>(() => new Set())
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({})
  const canAddress = source === 'local' ? isScope(doc.scope) : Boolean(doc.spaceId)
  const ready = Boolean(storedDocument && (source === 'local' || storedDocument.revision))
  const localSave = useMutation(trpc.doc.set.mutationOptions())
  const hostedSave = useMutation(trpc.record.saveDoc.mutationOptions())

  const settled = (field: Field) =>
    setPending((current) => {
      const next = new Set(current)
      next.delete(field)
      return next
    })
  const callbacks = (field: Field) => ({
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      settled(field)
    },
    onError: (cause: unknown) => {
      setErrors((current) => ({
        ...current,
        [field]: cause instanceof Error ? cause.message : String(cause),
      }))
      settled(field)
    },
  })

  function save(change: DocFieldChange) {
    if (!canAddress || !storedDocument) return
    setErrors((current) => ({ ...current, [change.field]: undefined }))
    setPending((current) => new Set(current).add(change.field))
    if (source === 'hosted') {
      if (!doc.spaceId || !storedDocument.revision) return
      hostedSave.mutate(
        fieldWriteInput(
          'hosted',
          { ...doc, spaceId: doc.spaceId },
          { ...storedDocument, revision: storedDocument.revision },
          change,
        ),
        callbacks(change.field),
      )
      return
    }
    localSave.mutate(fieldWriteInput('local', doc, storedDocument, change), callbacks(change.field))
  }

  return {
    canAddress,
    save,
    disabled: (field: Field) => !ready || pending.has(field),
    error: (field: Field) => errors[field],
  }
}

type FieldSave = ReturnType<typeof useDocFieldSave>

function useSubjects(doc: DocsDoc, source: DocsSource, canAddress: boolean) {
  const project = doc.projectName ?? ''
  const enabled = doc.kind === 'article' && canAddress && Boolean(project)
  const local = useQuery({
    ...trpc.subject.list.queryOptions({ project }),
    enabled: source === 'local' && enabled,
  })
  const hosted = useQuery({
    ...trpc.record.subjects.queryOptions({
      spaceId: doc.spaceId ?? '00000000-0000-4000-8000-000000000000',
      project,
    }),
    enabled: source === 'hosted' && enabled,
  })
  const query = source === 'hosted' ? hosted : local
  return {
    // Until the catalog has arrived, a menu built from it would offer only "None".
    ready: enabled && query.isSuccess,
    error: enabled ? query.error?.message : undefined,
    subjects: (query.data ?? []).map(({ id, name }): DocArticleSubject => ({ id, name })),
  }
}

function FieldError({ message }: { message?: string }) {
  return message ? (
    <p data-tone="error" className="m-0 mt-1 text-sm text-status-text">
      {message}
    </p>
  ) : null
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-text-muted">{label}</dt>
      <dd className="m-0 min-w-0 text-text-secondary">{children}</dd>
    </>
  )
}

/** An editable value's trigger: the whole row is the target, with a chevron at its end. */
const fieldTrigger =
  'group flex w-full min-w-0 cursor-pointer items-center justify-between gap-2 text-left hover:text-text-primary disabled:cursor-default'

function RowChevron() {
  return (
    <ChevronDown
      aria-hidden
      size={14}
      className="shrink-0 text-icon-muted group-hover:text-text-primary group-disabled:invisible"
    />
  )
}

/** A field's value shown as text; an editor clicks it to choose another value. */
function ChoiceText({
  label,
  value,
  options,
  disabled,
  onChoose,
}: {
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  disabled: boolean
  onChoose: (value: string) => void
}) {
  const current = options.find((option) => option.value === value)?.label ?? 'None'
  return (
    <Menu
      trigger={
        <button
          type="button"
          disabled={disabled}
          title={`Change ${label.toLowerCase()}`}
          className={fieldTrigger}
        >
          <span className="min-w-0 truncate">{current}</span>
          <RowChevron />
        </button>
      }
      items={options.map((option) => ({
        label: option.label,
        onSelect: () => {
          if (option.value !== value) onChoose(option.value)
        },
      }))}
    />
  )
}

/** How many chosen values show as chips before the rest fold into a count. */
const VISIBLE_CHIPS = 2

/**
 * Several values shown as chips, the rest folded into "+N". An editor clicks them to tick values
 * in a list; the choice is saved once, as one revision, when the list closes.
 */
function ChipChoices<T extends string>({
  label,
  options,
  selected,
  disabled,
  required = false,
  onSave,
}: {
  label: string
  options: readonly { value: T; label: string }[]
  selected: readonly T[]
  disabled: boolean
  /** At least one value must stay chosen. */
  required?: boolean
  onSave: (values: T[]) => void
}) {
  const [draft, setDraft] = useState<T[] | null>(null)
  const chosen = draft ?? [...selected]
  const labelOf = (value: T) => options.find((option) => option.value === value)?.label ?? value
  const shown = chosen.slice(0, VISIBLE_CHIPS)
  const hidden = chosen.length - shown.length
  const toggle = (value: T) => {
    const next = chosen.includes(value)
      ? chosen.filter((item) => item !== value)
      : [...chosen, value]
    if (required && next.length === 0) return
    setDraft(options.map((option) => option.value).filter((item) => next.includes(item)))
  }
  const changed = (values: readonly T[]) =>
    values.length !== selected.length || values.some((value) => !selected.includes(value))
  return (
    <Popover
      label={label}
      onOpenChange={(open) => {
        if (open) {
          setDraft([...selected])
          return
        }
        if (draft && changed(draft)) onSave(draft)
        setDraft(null)
      }}
      trigger={
        <button
          type="button"
          disabled={disabled}
          title={`Change ${label.toLowerCase()}`}
          className={fieldTrigger}
        >
          <span className="flex min-h-6 min-w-0 flex-wrap items-center gap-1">
            {chosen.length ? (
              <>
                {shown.map((value) => (
                  <Badge key={value} icon={false}>
                    {labelOf(value)}
                  </Badge>
                ))}
                {hidden > 0 ? (
                  <Badge icon={false} title={chosen.slice(VISIBLE_CHIPS).map(labelOf).join(', ')}>
                    {`+${hidden}`}
                  </Badge>
                ) : null}
              </>
            ) : (
              <span className="text-text-muted">None</span>
            )}
          </span>
          <RowChevron />
        </button>
      }
    >
      <div className="grid gap-1.5">
        {options.map((option) => (
          <label
            key={option.value}
            htmlFor={`${label}-${option.value}`}
            className="flex items-center gap-2 text-md text-text-secondary"
          >
            <Checkbox
              id={`${label}-${option.value}`}
              checked={chosen.includes(option.value)}
              onChange={() => toggle(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </Popover>
  )
}

/** A long list of choices as a field: its value as text, searched in a panel. */
function SearchChoice({
  label,
  value,
  options,
  disabled,
  onChoose,
}: {
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  disabled: boolean
  onChoose: (value: string) => void
}) {
  const current = options.find((option) => option.value === value)?.label ?? 'None'
  return (
    <SearchSelect
      label={label}
      value={value}
      options={options}
      onChange={onChoose}
      trigger={
        <button
          type="button"
          disabled={disabled}
          title={`Change ${label.toLowerCase()}`}
          className={fieldTrigger}
        >
          <span className="min-w-0 truncate">{current}</span>
          <RowChevron />
        </button>
      }
    />
  )
}

/** The status on the line under the title. An editor clicks it to choose another. */
export function EditableStatus({ doc, source }: { doc: DocsDoc; source: DocsSource }) {
  const field = useDocFieldSave(doc, source)
  const Icon = DOC_STATUS_ICONS[doc.status]
  const label = (
    <>
      <Icon size={14} />
      {DOC_STATUS_LABELS[doc.status]}
    </>
  )
  const fixed = !field.canAddress || doc.status === 'superseded' || doc.status === 'archived'
  if (fixed) return <span className="inline-flex items-center gap-1.5">{label}</span>
  const choose = (status: 'draft' | 'current') => () => {
    if (status !== doc.status) field.save({ field: 'status', value: status })
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <Menu
        trigger={
          <button
            type="button"
            disabled={field.disabled('status')}
            title="Change status"
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm hover:text-text-primary disabled:cursor-default"
          >
            {label}
          </button>
        }
        items={(['draft', 'current'] as const).map((status) => ({
          label: DOC_STATUS_LABELS[status],
          icon: DOC_STATUS_ICONS[status],
          onSelect: choose(status),
        }))}
      />
      <FieldError message={field.error('status')} />
    </span>
  )
}

function ParentRow({ doc, source, field }: { doc: DocsDoc; source: DocsSource; field: FieldSave }) {
  const tree = useDocsTree(source)
  const choices = parentChoices(doc, tree.items)
  const title = tree.items.find(({ id }) => id === doc.parentId)?.title ?? 'Top level'
  return (
    <Row label="Parent">
      {field.canAddress ? (
        <SearchChoice
          label="Parent"
          value={doc.parentId ?? ''}
          options={[
            { value: '', label: 'Top level' },
            ...choices.map((item) => ({ value: item.id, label: item.title })),
          ]}
          disabled={field.disabled('parent')}
          onChoose={(id) =>
            field.save({ field: 'parent', value: choices.find((item) => item.id === id) ?? null })
          }
        />
      ) : (
        title
      )}
      <FieldError message={field.error('parent')} />
    </Row>
  )
}

function AudienceRow({ doc, field }: { doc: DocsDoc; field: FieldSave }) {
  return (
    <Row label="Audience">
      {field.canAddress ? (
        <ChipChoices
          label="Audience"
          options={DOC_AUDIENCES.map((value) => ({ value, label: DOC_AUDIENCE_LABELS[value] }))}
          selected={doc.audiences}
          disabled={field.disabled('audiences')}
          required
          onSave={(values) => {
            const value = audiencesFrom(values)
            if (value) field.save({ field: 'audiences', value })
          }}
        />
      ) : (
        doc.audiences.map((audience) => DOC_AUDIENCE_LABELS[audience]).join(', ')
      )}
      <FieldError message={field.error('audiences')} />
    </Row>
  )
}

function ArticleRows({
  doc,
  source,
  field,
}: {
  doc: DocsDoc
  source: DocsSource
  field: FieldSave
}) {
  const catalog = useSubjects(doc, source, field.canAddress)
  const related = doc.relatedSubjects ?? []
  const known = withCurrentSubjects(catalog.subjects, [
    ...(doc.articleSubject ? [doc.articleSubject] : []),
    ...related,
  ])
  const subjectChoices = subjectsExcept(known, related)
  return (
    <>
      <SummaryRow doc={doc} field={field} />
      <Row label="Type">
        {field.canAddress ? (
          <ChoiceText
            label="Type"
            value={doc.form ?? ''}
            options={[
              { value: '', label: 'None' },
              ...DOC_FORMS.map((form) => ({ value: form, label: DOC_FORM_LABELS[form] })),
            ]}
            disabled={field.disabled('form')}
            onChoose={(value) =>
              field.save({ field: 'form', value: (value || null) as DocForm | null })
            }
          />
        ) : doc.form ? (
          DOC_FORM_LABELS[doc.form]
        ) : (
          'None'
        )}
        <FieldError message={field.error('form')} />
      </Row>
      <Row label="Subject">
        {catalog.ready ? (
          <ChoiceText
            label="Subject"
            value={doc.articleSubject?.id ?? ''}
            options={[
              { value: '', label: 'None' },
              ...subjectChoices.map(({ id, name }) => ({ value: id, label: name })),
            ]}
            disabled={field.disabled('articleSubject')}
            onChoose={(id) =>
              field.save({
                field: 'articleSubject',
                value: subjectChoices.find((item) => item.id === id) ?? null,
              })
            }
          />
        ) : (
          (doc.articleSubject?.name ?? 'None')
        )}
        <FieldError message={field.error('articleSubject') ?? catalog.error} />
      </Row>
      <Row label="Related">
        {catalog.ready ? (
          <ChipChoices
            label="Related subjects"
            options={subjectsExcept(known, doc.articleSubject ? [doc.articleSubject] : []).map(
              ({ id, name }) => ({ value: id, label: name }),
            )}
            selected={related.map(({ id }) => id)}
            disabled={field.disabled('relatedSubjects')}
            onSave={(ids) =>
              field.save({
                field: 'relatedSubjects',
                value: known
                  .filter(({ id }) => ids.includes(id))
                  .sort((left, right) => left.name.localeCompare(right.name)),
              })
            }
          />
        ) : (
          related.map(({ name }) => name).join(', ') || 'None'
        )}
        <FieldError message={field.error('relatedSubjects')} />
      </Row>
    </>
  )
}

function SummaryRow({ doc, field }: { doc: DocsDoc; field: FieldSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(doc.summarySource === 'written' ? (doc.summary ?? '') : '')
  const save = () => {
    setEditing(false)
    const next = draft.trim() || null
    const current = doc.summarySource === 'written' ? (doc.summary ?? '') : null
    if (next !== current) field.save({ field: 'summary', value: next })
  }
  return (
    <Row label="Summary">
      {editing ? (
        <Input
          autoFocus
          maxLength={DOC_SUMMARY_MAX_LENGTH}
          value={draft}
          disabled={field.disabled('summary')}
          aria-label="Summary"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              setDraft(doc.summarySource === 'written' ? (doc.summary ?? '') : '')
              setEditing(false)
            }
          }}
        />
      ) : (
        <button
          type="button"
          className={fieldTrigger}
          disabled={!field.canAddress || field.disabled('summary')}
          title="Change summary"
          onClick={() => setEditing(true)}
        >
          <span className={doc.summarySource === 'derived' ? 'text-text-muted' : undefined}>
            {doc.summary || 'None'}
            {doc.summarySource === 'derived' ? (
              <span className="mt-1 block text-xs">From the opening paragraph</span>
            ) : null}
          </span>
          <RowChevron />
        </button>
      )}
      <FieldError message={field.error('summary')} />
    </Row>
  )
}

function DeliveryRow({ doc, field }: { doc: DocsDoc; field: FieldSave }) {
  const delivery = doc.delivery ?? 'inject'
  return (
    <Row label="Delivery">
      {field.canAddress ? (
        <ChoiceText
          label="Delivery"
          value={delivery}
          options={(['inject', 'demand'] as const).map((value) => ({
            value,
            label: DOC_DELIVERY_LABELS[value],
          }))}
          disabled={field.disabled('delivery')}
          onChoose={(value) =>
            field.save({ field: 'delivery', value: value as 'inject' | 'demand' })
          }
        />
      ) : (
        DOC_DELIVERY_LABELS[delivery]
      )}
      <FieldError message={field.error('delivery')} />
    </Row>
  )
}

/** The About rows for a reader who may edit: each field is changed where it is shown. */
export function EditableAbout({ doc, source }: { doc: DocsDoc; source: DocsSource }) {
  const field = useDocFieldSave(doc, source)
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2.5 text-md">
      <ParentRow doc={doc} source={source} field={field} />
      <AudienceRow doc={doc} field={field} />
      {doc.kind === 'article' ? (
        <ArticleRows doc={doc} source={source} field={field} />
      ) : (
        <DeliveryRow doc={doc} field={field} />
      )}
    </dl>
  )
}

/** The article's source files under "In the code", added and removed in place. */
export function EditableSourceFiles({ doc, source }: { doc: DocsDoc; source: DocsSource }) {
  const field = useDocFieldSave(doc, source)
  const [path, setPath] = useState('')
  const files = doc.sourceFiles ?? []
  const disabled = !field.canAddress || field.disabled('sourceFiles')
  return (
    <CodeSection count={files.length} defaultOpen={files.length === 0}>
      {files.length ? (
        <ul>
          {files.map((file) => (
            <li key={file}>
              <span className="inline-flex max-w-full items-center gap-2">
                <code className="min-w-0 break-all">{file}</code>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  aria-label={`Remove ${file}`}
                  onClick={() =>
                    field.save({
                      field: 'sourceFiles',
                      value: files.filter((value) => value !== file),
                      action: 'removed',
                      path: file,
                    })
                  }
                >
                  <X size={14} />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          const next = path.trim()
          if (!next || disabled) return
          field.save({ field: 'sourceFiles', value: [...files, next], action: 'added', path: next })
          setPath('')
        }}
      >
        <Input
          size="sm"
          className="flex-1"
          aria-label="Source file path"
          placeholder="Add a repository path"
          value={path}
          disabled={disabled}
          onChange={(event) => setPath(event.target.value)}
        />
        <Button size="sm" type="submit" disabled={disabled || !path.trim()}>
          Add
        </Button>
      </form>
      <FieldError message={field.error('sourceFiles')} />
    </CodeSection>
  )
}
