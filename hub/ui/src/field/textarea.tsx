import type { Ref, TextareaHTMLAttributes } from 'react'
import { classes } from '../text/classes'
import { controlClasses } from './control'

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
    <textarea
      {...props}
      rows={rows}
      className={classes(
        controlClasses,
        'field-sizing-content min-h-20 w-full resize-none px-3 py-2',
        code && 'font-mono text-sm',
        bare && 'border-transparent hover:border-transparent focus-visible:border-transparent',
        className,
      )}
    />
  )
}
