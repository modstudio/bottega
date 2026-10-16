import { Check, Minus } from 'lucide-react'
import { type InputHTMLAttributes, type Ref, useEffect, useRef } from 'react'
import { checkboxStyles } from './checkbox.styles.ts'

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
    <span className={checkboxStyles().root({ class: className })}>
      <input
        {...props}
        ref={(node) => {
          own.current = node
          if (typeof ref === 'function') ref(node)
          else if (ref) ref.current = node
        }}
        type="checkbox"
        aria-checked={indeterminate ? 'mixed' : undefined}
        className={checkboxStyles().input()}
      />
      <Mark aria-hidden strokeWidth={3} className={checkboxStyles().mark()} />
    </span>
  )
}
