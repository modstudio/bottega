import type { InputHTMLAttributes, Ref } from 'react'
import { inputStyles } from './input.styles.ts'

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'size'> & {
  ref?: Ref<HTMLInputElement>
  /** `title` edits a heading in place, at the heading's size. */
  size?: 'sm' | 'md' | 'title'
  /** Layout only: margin, width and placement. */
  className?: string
}

export function Input({ size = 'md', className, type = 'text', ...props }: InputProps) {
  return <input {...props} type={type} className={inputStyles({ size, class: className })} />
}
