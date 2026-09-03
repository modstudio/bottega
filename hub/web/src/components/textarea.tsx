import type { ComponentProps } from 'react'
import { cx } from '@/components/cx'

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cx(
        'flex min-h-[80px] w-full rounded-none border border-input bg-background px-3 py-2 text-[13px] ring-offset-background placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
