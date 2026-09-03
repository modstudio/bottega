import type { ComponentProps } from 'react'
import { cx } from '@/components/cx'

export function Checkbox({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return (
    <input
      type="checkbox"
      className={cx('h-4 w-4 shrink-0 accent-primary', className)}
      {...props}
    />
  )
}
