import type { HTMLAttributes } from 'react'
import { cx } from '@/components/cx'

const variants = {
  default: 'border-transparent bg-primary text-primary-foreground hover:bg-primary/80',
  secondary: 'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
  destructive: 'border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80',
  success: 'border-transparent bg-success text-success-foreground hover:bg-success/80',
  warning: 'border-transparent bg-warning text-warning-foreground hover:bg-warning/80',
  info: 'border-transparent bg-info text-info-foreground hover:bg-info/80',
  live: 'border-transparent bg-live text-live-foreground hover:bg-live/80',
  danger: 'border-transparent bg-danger text-danger-foreground hover:bg-danger/80',
  outline: 'text-foreground',
} as const

type BadgeProps = HTMLAttributes<HTMLDivElement> & { variant?: keyof typeof variants }

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <div
      className={cx(
        'inline-flex items-center rounded-none border px-2.5 py-0.5 text-xs font-semibold focus:ring-2 focus:ring-ring focus:ring-offset-2',
        variants[variant],
        className,
      )}
      {...props}
    />
  )
}
