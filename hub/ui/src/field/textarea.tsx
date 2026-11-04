import type { ReactNode, Ref, TextareaHTMLAttributes } from 'react'
import { ControlWithHint, useFieldHint } from './control.ts'
import { textareaStyles } from './textarea.styles.ts'

type TextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> & {
  ref?: Ref<HTMLTextAreaElement>
  /** The content is code or configuration: set in mono. */
  code?: boolean
  /** No frame of its own, for a textarea that fills a framed pane. */
  bare?: boolean
  /** Help shown below the control and announced with it. */
  hint?: ReactNode
  /** Layout only: margin, width and placement. */
  className?: string
}

export function Textarea({
  code = false,
  bare = false,
  hint,
  className,
  rows = 4,
  ...props
}: TextareaProps) {
  const { hintId, describedBy } = useFieldHint(hint, props['aria-describedby'])
  const control = (
    <textarea
      {...props}
      rows={rows}
      aria-describedby={describedBy || undefined}
      className={textareaStyles({ code, bare }).control({ class: className })}
    />
  )
  return (
    <ControlWithHint
      className={textareaStyles().root()}
      control={control}
      hint={hint}
      hintId={hintId}
    />
  )
}
