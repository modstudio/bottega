import type { HTMLAttributes } from 'react'
import { cx } from '@/components/cx'

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx('rounded-none border bg-card text-card-foreground shadow-sm', className)}
      {...props}
    />
  )
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('p-6 pt-0', className)} {...props} />
}
