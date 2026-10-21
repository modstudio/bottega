import { Copy } from 'lucide-react'
import type { ReactNode } from 'react'
import { IconButton } from '../button/button'
import { toast } from '../toast/toast'
import { formLayoutStyles } from './form-layout.styles.ts'

/** A titled group of related settings or facts. */
export function FieldSection({
  title,
  description,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <section className={formLayoutStyles().section()}>
      <div>
        <h2 className={formLayoutStyles().sectionTitle()}>{title}</h2>
        {description ? (
          <p className={formLayoutStyles().sectionDescription()}>{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  )
}

/**
 * One editable setting: its name, the control, what it means, and the command
 * that makes the same change from a terminal.
 */
export function SettingBlock({
  label,
  control,
  hint,
  cli,
}: {
  label: ReactNode
  control: ReactNode
  hint?: ReactNode
  cli?: string
}) {
  return (
    <div className={formLayoutStyles().field()}>
      <div className={formLayoutStyles().fieldLabel()}>{label}</div>
      <div>{control}</div>
      {hint ? <div className={formLayoutStyles().fieldHint()}>{hint}</div> : null}
      {cli ? <Copyable value={cli} compact /> : null}
    </div>
  )
}

/** A fact that is read, not edited: label beside value when there is room. */
export function DisplayRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className={formLayoutStyles().displayRow()}>
      <div className={formLayoutStyles().displayGrid()}>
        <div className={formLayoutStyles().displayLabel()}>{label}</div>
        <div className={formLayoutStyles().displayValue()}>{value ?? '-'}</div>
      </div>
    </div>
  )
}

/** A value the reader will want to paste elsewhere, with a copy button. */
export function Copyable({ value, compact = false }: { value: string; compact?: boolean }) {
  const copy = async () => {
    await navigator.clipboard.writeText(value)
    toast.success('Copied')
  }
  return (
    <div className={formLayoutStyles({ compact }).copyable()}>
      <code className={formLayoutStyles().copyableValue()}>{value}</code>
      <IconButton size="sm" label="Copy value" onClick={copy}>
        <Copy />
      </IconButton>
    </div>
  )
}
