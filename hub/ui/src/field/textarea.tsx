import type { Ref, TextareaHTMLAttributes } from 'react'
import { textareaStyles } from './textarea.styles.ts'

type TextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> & {
  ref?: Ref<HTMLTextAreaElement>
  /** The content is code or configuration: set in mono. */
  code?: boolean
  /** No frame of its own, for a textarea that fills a framed pane. */
  bare?: boolean
  /** Layout only: margin, width and placement. */
  className?: string
}

export function Textarea({
  code = false,
  bare = false,
  className,
  rows = 4,
  ...props
}: TextareaProps) {
  return (
    <textarea {...props} rows={rows} className={textareaStyles({ code, bare, class: className })} />
  )
}
