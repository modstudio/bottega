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
    <section className={formLayoutStyles().slot1()}>
      <div>
        <h2 className={formLayoutStyles().slot2()}>{title}</h2>
        {description ? <p className={formLayoutStyles().slot3()}>{description}</p> : null}
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
    <div className={formLayoutStyles().slot4()}>
      <div className={formLayoutStyles().slot5()}>{label}</div>
      <div>{control}</div>
      {hint ? <div className={formLayoutStyles().slot6()}>{hint}</div> : null}
      {cli ? <Copyable value={cli} compact /> : null}
    </div>
  )
}

/** A fact that is read, not edited: label beside value when there is room. */
export function DisplayRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className={formLayoutStyles().slot7()}>
      <div className={formLayoutStyles().slot8()}>
        <div className={formLayoutStyles().slot9()}>{label}</div>
        <div className={formLayoutStyles().slot10()}>{value ?? '-'}</div>
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
      <code className={formLayoutStyles().slot11()}>{value}</code>
      <IconButton size="sm" label="Copy value" onClick={copy}>
        <Copy />
      </IconButton>
    </div>
  )
}
