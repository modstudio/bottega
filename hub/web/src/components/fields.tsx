import type { ReactNode } from 'react'
import { Copy } from 'lucide-react'
import { Button } from './button'
import { toast } from './toaster'

export function FieldSection({ title, description, children }: {
  title: ReactNode; description?: ReactNode; children: ReactNode
}) {
  return <section className="space-y-4 border-t border-border pt-4 first:border-t-0 first:pt-0">
    <div><h2 className="font-sans text-[15px] font-semibold">{title}</h2>{description ? <p className="mt-1 text-muted-foreground">{description}</p> : null}</div>
    {children}
  </section>
}

export function SettingBlock({ label, control, hint, cli }: {
  label: ReactNode; control: ReactNode; hint?: ReactNode; cli?: string
}) {
  return <div className="space-y-1">
    <div className="text-[12.5px] text-muted-foreground">{label}</div>
    <div>{control}</div>
    {hint ? <div className="text-[11px] text-muted-foreground">{hint}</div> : null}
    {cli ? <Copyable value={cli} compact /> : null}
  </div>
}

export function DisplayRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return <div className="grid gap-1 border-b border-border py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
    <div className="text-muted-foreground">{label}</div>
    <div className="min-w-0 break-words">{value ?? '-'}</div>
  </div>
}

export function Copyable({ value, compact = false }: { value: string; compact?: boolean }) {
  const copy = async () => {
    await navigator.clipboard.writeText(value)
    toast.success('Copied')
  }
  return <div className={`flex min-w-0 items-center gap-2 ${compact ? 'text-[11px] text-muted-foreground' : ''}`}>
    <code className="min-w-0 flex-1 break-all">{value}</code>
    <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={copy} aria-label="Copy value"><Copy size={13} /></Button>
  </div>
}
