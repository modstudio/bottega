import { Copy } from 'lucide-react'
import type { ReactNode } from 'react'
import { IconButton } from '../button/button'
import { classes } from '../text/classes'
import { toast } from '../toast/toast'

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
    <section className="flex flex-col gap-4 border-border-subtle border-t pt-5 first:border-t-0 first:pt-0">
      <div>
        <h2 className="font-semibold text-md">{title}</h2>
        {description ? <p className="mt-1 text-sm text-text-secondary">{description}</p> : null}
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
    <div className="flex flex-col gap-1.5">
      <div className="font-medium text-sm text-text-secondary">{label}</div>
      <div>{control}</div>
      {hint ? <div className="text-sm text-text-muted">{hint}</div> : null}
      {cli ? <Copyable value={cli} compact /> : null}
    </div>
  )
}

/** A fact that is read, not edited: label beside value when there is room. */
export function DisplayRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="@container/row border-border-subtle border-b py-2.5 last:border-b-0">
      <div className="grid gap-1 @md/row:grid-cols-[9rem_minmax(0,1fr)] @md/row:gap-4">
        <div className="text-sm text-text-muted">{label}</div>
        <div className="min-w-0 break-words">{value ?? '-'}</div>
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
    <div
      className={classes('flex min-w-0 items-center gap-2', compact && 'text-sm text-text-muted')}
    >
      <code className="min-w-0 flex-1 break-all font-mono">{value}</code>
      <IconButton size="sm" label="Copy value" onClick={copy}>
        <Copy />
      </IconButton>
    </div>
  )
}
