import { LoaderCircle } from 'lucide-react'
import { spinnerStyles } from './spinner.styles.ts'

/** Work under way with no known end. `label` is announced; omit it when nearby text already says so. */
export function Spinner({ label, className }: { label?: string; className?: string }) {
  return (
    <span
      role={label ? 'status' : undefined}
      className={spinnerStyles().root({ class: className })}
    >
      <LoaderCircle aria-hidden className={spinnerStyles().slot1()} />
      {label ? <span className={spinnerStyles().slot2()}>{label}</span> : null}
    </span>
  )
}
