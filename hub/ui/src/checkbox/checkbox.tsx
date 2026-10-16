import { Check, Minus } from 'lucide-react'
import { type InputHTMLAttributes, type Ref, useEffect, useRef } from 'react'
import { classes } from '../text/classes'

type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'> & {
  ref?: Ref<HTMLInputElement>
  /** Neither checked nor unchecked, as for a group partly selected. */
  indeterminate?: boolean
  /** Layout only: margin and placement. */
  className?: string
}

/**
 * A native checkbox, kept for its semantics and form behavior, drawn entirely
 * by us: the box is the input itself and the mark sits over it.
 */
export function Checkbox({ indeterminate = false, className, ref, ...props }: CheckboxProps) {
  const own = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (own.current) own.current.indeterminate = indeterminate
  }, [indeterminate])
  const Mark = indeterminate ? Minus : Check
  return (
    <span className={classes('relative inline-grid size-4 shrink-0 place-items-center', className)}>
      <input
        {...props}
        ref={(node) => {
          own.current = node
          if (typeof ref === 'function') ref(node)
          else if (ref) ref.current = node
        }}
        type="checkbox"
        aria-checked={indeterminate ? 'mixed' : undefined}
        className="peer col-start-1 row-start-1 size-4 cursor-pointer border border-border-strong bg-surface-page transition-colors checked:border-accent-fill checked:bg-accent-fill indeterminate:border-accent-fill indeterminate:bg-accent-fill hover:border-text-muted disabled:cursor-not-allowed disabled:border-border-default disabled:bg-control-disabled disabled:checked:opacity-50"
      />
      <Mark
        aria-hidden
        strokeWidth={3}
        className="pointer-events-none col-start-1 row-start-1 size-3 text-accent-on-fill opacity-0 peer-checked:opacity-100 peer-indeterminate:opacity-100"
      />
    </span>
  )
}
