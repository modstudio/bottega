import type { InputHTMLAttributes, Ref } from 'react'
import { switchStyles } from './switch.styles.ts'

type SwitchProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'role' | 'className'> & {
  ref?: Ref<HTMLInputElement>
  /** Layout only: margin and placement. */
  className?: string
}

/** An on/off setting that applies at once. A native checkbox with the switch role, drawn by us. */
export function Switch({ className, ...props }: SwitchProps) {
  return (
    <input
      {...props}
      type="checkbox"
      role="switch"
      aria-checked={props.checked}
      className={switchStyles({ class: className })}
    />
  )
}
