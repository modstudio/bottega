import { Badge } from '@bottega/hub-ui/badge'
import { Button } from '@bottega/hub-ui/button'
import { Checkbox } from '@bottega/hub-ui/checkbox'
import { Input } from '@bottega/hub-ui/field/input'
import { SearchSelect } from '@bottega/hub-ui/listbox/search-select'
import { Menu } from '@bottega/hub-ui/menu'
import { Popover } from '@bottega/hub-ui/popover'
import { ChevronDown, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
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
  parentChoices,
  subjectsExcept,
  withCurrentSubjects,
} from './doc-field-changes.ts'
import { docFieldControlsStyles } from './doc-field-controls.styles.ts'
import {
  DOC_AUDIENCE_LABELS,
  DOC_DELIVERY_LABELS,
  DOC_FORM_LABELS,
  DOC_STATUS_LABELS,
} from './filters.ts'
import { DOC_STATUS_ICONS } from './status-icon.ts'
import type { DocsDoc, DocsTreeItem } from './types.ts'

type Field = DocFieldChange['field']

export type FieldSave = {
  canAddress: boolean
  run: (change: DocFieldChange) => void
  pending: boolean
  error: unknown
  refused?: string
  disabled: (field: Field) => boolean
  errorFor: (field: Field) => string | undefined
}

export type SubjectCatalog = {
  ready: boolean
  error?: string
  subjects: DocArticleSubject[]
}

function FieldError({ message }: { message?: string }) {
  return message ? (
    <p data-tone="error" className={docFieldControlsStyles().error()}>
      {message}
    </p>
  ) : null
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className={docFieldControlsStyles().fieldLabel()}>{label}</dt>
      <dd className={docFieldControlsStyles().fieldValue()}>{children}</dd>
    </>
  )
}

/** An editable value's trigger: the whole row is the target, with a chevron at its end. */
function RowChevron() {
  return <ChevronDown aria-hidden size={14} className={docFieldControlsStyles().chevronDown()} />
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
          className={docFieldControlsStyles().fieldTrigger()}
        >
          <span className={docFieldControlsStyles().selectedValue()}>{current}</span>
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
          className={docFieldControlsStyles().fieldTrigger()}
        >
          <span className={docFieldControlsStyles().audienceList()}>
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
              <span className={docFieldControlsStyles().emptyValue()}>None</span>
            )}
          </span>
          <RowChevron />
        </button>
      }
    >
      <div className={docFieldControlsStyles().audienceOptions()}>
        {options.map((option) => (
          <label
            key={option.value}
            htmlFor={`${label}-${option.value}`}
            className={docFieldControlsStyles().audienceOption()}
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
          className={docFieldControlsStyles().fieldTrigger()}
        >
          <span className={docFieldControlsStyles().kindValue()}>{current}</span>
          <RowChevron />
        </button>
      }
    />
  )
}

/** The status on the line under the title. An editor clicks it to choose another. */
export function EditableStatus({ doc, field }: { doc: DocsDoc; field: FieldSave }) {
  const Icon = DOC_STATUS_ICONS[doc.status]
  const label = (
    <>
      <Icon size={14} />
      {DOC_STATUS_LABELS[doc.status]}
    </>
  )
  const fixed = !field.canAddress || doc.status === 'superseded' || doc.status === 'archived'
  if (fixed) return <span className={docFieldControlsStyles().fixedScope()}>{label}</span>
  const choose = (status: 'draft' | 'current') => () => {
    if (status !== doc.status) field.run({ field: 'status', value: status })
  }
  return (
    <span className={docFieldControlsStyles().scopePicker()}>
      <Menu
        trigger={
          <button
            type="button"
            disabled={field.disabled('status')}
            title="Change status"
            className={docFieldControlsStyles().scopeOption()}
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
      <FieldError message={field.errorFor('status')} />
    </span>
  )
}

function ParentRow({
  doc,
  items,
  field,
}: {
  doc: DocsDoc
  items: readonly DocsTreeItem[]
  field: FieldSave
}) {
  const choices = parentChoices(doc, items)
  const title = items.find(({ id }) => id === doc.parentId)?.title ?? 'Top level'
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
            field.run({ field: 'parent', value: choices.find((item) => item.id === id) ?? null })
          }
        />
      ) : (
        title
      )}
      <FieldError message={field.errorFor('parent')} />
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
            if (value) field.run({ field: 'audiences', value })
          }}
        />
      ) : (
        doc.audiences.map((audience) => DOC_AUDIENCE_LABELS[audience]).join(', ')
      )}
      <FieldError message={field.errorFor('audiences')} />
    </Row>
  )
}

function ArticleRows({
  doc,
  field,
  catalog,
}: {
  doc: DocsDoc
  field: FieldSave
  catalog: SubjectCatalog
}) {
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
              field.run({ field: 'form', value: (value || null) as DocForm | null })
            }
          />
        ) : doc.form ? (
          DOC_FORM_LABELS[doc.form]
        ) : (
          'None'
        )}
        <FieldError message={field.errorFor('form')} />
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
              field.run({
                field: 'articleSubject',
                value: subjectChoices.find((item) => item.id === id) ?? null,
              })
            }
          />
        ) : (
          (doc.articleSubject?.name ?? 'None')
        )}
        <FieldError message={field.errorFor('articleSubject') ?? catalog.error} />
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
              field.run({
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
        <FieldError message={field.errorFor('relatedSubjects')} />
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
    if (next !== current) field.run({ field: 'summary', value: next })
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
          className={docFieldControlsStyles().fieldTrigger()}
          disabled={!field.canAddress || field.disabled('summary')}
          title="Change summary"
          onClick={() => setEditing(true)}
        >
          <span
            className={docFieldControlsStyles().summary({
              derived: doc.summarySource === 'derived',
            })}
          >
            {doc.summary || 'None'}
            {doc.summarySource === 'derived' ? (
              <span className={docFieldControlsStyles().summarySource()}>
                From the opening paragraph
              </span>
            ) : null}
          </span>
          <RowChevron />
        </button>
      )}
      <FieldError message={field.errorFor('summary')} />
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
            field.run({ field: 'delivery', value: value as 'inject' | 'demand' })
          }
        />
      ) : (
        DOC_DELIVERY_LABELS[delivery]
      )}
      <FieldError message={field.errorFor('delivery')} />
    </Row>
  )
}

/** The About rows for a reader who may edit: each field is changed where it is shown. */
export function EditableAbout({
  doc,
  field,
  items,
  subjects,
}: {
  doc: DocsDoc
  field: FieldSave
  items: readonly DocsTreeItem[]
  subjects: SubjectCatalog
}) {
  return (
    <dl className={docFieldControlsStyles().fields()}>
      <ParentRow doc={doc} items={items} field={field} />
      <AudienceRow doc={doc} field={field} />
      {doc.kind === 'article' ? (
        <ArticleRows doc={doc} field={field} catalog={subjects} />
      ) : (
        <DeliveryRow doc={doc} field={field} />
      )}
    </dl>
  )
}

/** The article's source files under "In the code", added and removed in place. */
export function EditableSourceFiles({ doc, field }: { doc: DocsDoc; field: FieldSave }) {
  const [path, setPath] = useState('')
  const files = doc.sourceFiles ?? []
  const disabled = !field.canAddress || field.disabled('sourceFiles')
  return (
    <CodeSection count={files.length} defaultOpen={files.length === 0}>
      {files.length ? (
        <ul>
          {files.map((file) => (
            <li key={file}>
              <span className={docFieldControlsStyles().sourceFile()}>
                <code className={docFieldControlsStyles().sourceFilePath()}>{file}</code>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  aria-label={`Remove ${file}`}
                  onClick={() =>
                    field.run({
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
        className={docFieldControlsStyles().actions()}
        onSubmit={(event) => {
          event.preventDefault()
          const next = path.trim()
          if (!next || disabled) return
          field.run({ field: 'sourceFiles', value: [...files, next], action: 'added', path: next })
          setPath('')
        }}
      >
        <Input
          size="sm"
          className={docFieldControlsStyles().input()}
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
      <FieldError message={field.errorFor('sourceFiles')} />
    </CodeSection>
  )
}
