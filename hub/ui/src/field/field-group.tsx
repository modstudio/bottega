import type { ReactNode } from 'react'
import { FieldHint, useFieldHint } from './control.ts'
import { fieldGroupStyles } from './field-group.styles.ts'

/** Related form controls with a visible name and shared help. */
export function FieldGroup({
  legend,
  hint,
  children,
}: {
  legend: ReactNode
  hint?: ReactNode
  children: ReactNode
}) {
  const { hintId, describedBy } = useFieldHint(hint)
  return (
    <fieldset aria-describedby={describedBy} className={fieldGroupStyles().root()}>
      <legend className={fieldGroupStyles().legend()}>{legend}</legend>
      {hint ? (
        <FieldHint id={hintId} as="div">
          {hint}
        </FieldHint>
      ) : null}
      <div className={fieldGroupStyles().content()}>{children}</div>
    </fieldset>
  )
}
