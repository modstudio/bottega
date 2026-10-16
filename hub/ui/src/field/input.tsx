import type { InputHTMLAttributes, Ref } from 'react'
import { classes } from '../text/classes'
import { controlClasses } from './control'

const sizes = {
  sm: 'h-control-sm px-2 text-sm',
  md: 'h-control-md px-3',
  /** Edits a heading in place, at the heading's size. */
  title: 'h-control-lg px-2 font-semibold text-xl',
} as const

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'size'> & {
  ref?: Ref<HTMLInputElement>
  size?: keyof typeof sizes
  /** Layout only: margin, width and placement. */
  className?: string
}

export function Input({ size = 'md', className, type = 'text', ...props }: InputProps) {
  return (
    <input
      {...props}
      type={type}
      className={classes(controlClasses, 'w-full', sizes[size], className)}
    />
  )
}
