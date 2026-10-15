// concern: doc-reference-write
/** Applies generated-reference write authority at the local document service boundaries. */
import type { DocGenerator } from './doc-generator.ts'
import { isReferenceGeneratorWrite, referenceWriteRefusal } from './doc-write-allowed.ts'

type FormRow = { form?: string | null } | null | undefined
type ReferenceWrite = { form?: string | null; generator?: DocGenerator }

function refuse(refusal: string | null): void {
  if (refusal) throw new Error(refusal)
}

export function assertLocalReferenceWrite(prior: FormRow, input: ReferenceWrite): void {
  refuse(
    referenceWriteRefusal({
      storedForm: prior?.form,
      requestedForm: input.form,
      generator: input.generator,
    }),
  )
}

/** Generated reference pages are checked by the reference drift check, not prose lint. */
export function skipsProseLint(prior: FormRow, input: ReferenceWrite): boolean {
  return isReferenceGeneratorWrite({
    storedForm: prior?.form,
    requestedForm: input.form,
    generator: input.generator,
  })
}

export function assertLocalReferenceRestore(current: FormRow, revision: FormRow): void {
  refuse(referenceWriteRefusal({ storedForm: current?.form, requestedForm: revision?.form }))
}

export function assertLocalStoredReferenceWrite(row: FormRow, generator?: DocGenerator): void {
  refuse(referenceWriteRefusal({ storedForm: row?.form, generator }))
}
