// concern: record-doc-reference-write
/** Applies generated-reference write authority at hosted document service boundaries. */
import type { DocKind } from '../../../shared/docs.ts'
import type { DocGenerator } from '../doc/doc-write-allowed.ts'
import {
  isReferenceGeneratorWrite,
  recordDocLintRefusal,
  referenceWriteRefusal,
} from '../doc/doc-write-allowed.ts'
import { assertWrite } from './record-doc-errors.ts'

type StoredFormRow = { form?: unknown } | null | undefined
type StoredLintRow =
  | ({
      scope?: unknown
      subject?: unknown
      slug?: unknown
      body?: unknown
      kind?: unknown
    } & NonNullable<StoredFormRow>)
  | null
  | undefined

const storedForm = (row: StoredFormRow): string | null =>
  row?.form == null ? null : String(row.form)

export function assertHostedReferenceUpsertAllowed(
  existing: StoredFormRow,
  input: { form?: string | null; generator?: DocGenerator },
): void {
  assertWrite(
    referenceWriteRefusal({
      storedForm: storedForm(existing),
      requestedForm: input.form,
      generator: input.generator,
    }),
  )
}

export function assertHostedReferenceLintAllowed(
  existing: StoredLintRow,
  input: Omit<Parameters<typeof recordDocLintRefusal>[0], 'kind'> & {
    kind?: DocKind
    form?: string | null
    generator?: DocGenerator
  },
  kind: DocKind,
): void {
  // Generated reference pages are checked by the reference drift check, not prose lint.
  if (
    isReferenceGeneratorWrite({
      storedForm: storedForm(existing),
      requestedForm: input.form,
      generator: input.generator,
    })
  )
    return
  assertWrite(
    recordDocLintRefusal(
      { ...input, kind },
      existing
        ? {
            scope: String(existing.scope),
            subject: existing.subject == null ? null : String(existing.subject),
            slug: String(existing.slug),
            body: String(existing.body),
            kind: (existing.kind == null ? 'working' : String(existing.kind)) as DocKind,
          }
        : undefined,
    ),
  )
}

export function assertHostedStoredReferenceWriteAllowed(row: StoredFormRow): void {
  assertWrite(referenceWriteRefusal({ storedForm: storedForm(row) }))
}

export function assertHostedReferenceImportAllowed(
  existing: StoredFormRow,
  requestedForm: string | null | undefined,
): void {
  assertWrite(
    referenceWriteRefusal({
      storedForm: storedForm(existing),
      requestedForm,
    }),
  )
}
