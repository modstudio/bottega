import type { InputHTMLAttributes, ReactNode, Ref } from 'react'
import { ControlWithHint, useFieldHint } from './control.ts'
import { type ControlSize, useControlSize } from './control-size'
import { inputStyles } from './input.styles.ts'

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'size'> & {
  ref?: Ref<HTMLInputElement>
  /** `title` edits a heading in place, at the heading's size. */
  size?: ControlSize | 'title'
  /** Help shown below the control and announced with it. */
  hint?: ReactNode
  /** Layout only: margin, width and placement. */
  className?: string
}

export function Input({ size: own, hint, className, type = 'text', ...props }: InputProps) {
  const size = useControlSize(own, 'md')
  const { hintId, describedBy } = useFieldHint(hint, props['aria-describedby'])
  const control = (
    <input
      {...props}
      type={type}
      aria-describedby={describedBy || undefined}
      className={inputStyles({ size }).control({ class: className })}
    />
  )
  return (
    <ControlWithHint
      className={inputStyles().root()}
      control={control}
      hint={hint}
      hintId={hintId}
    />
  )
}
