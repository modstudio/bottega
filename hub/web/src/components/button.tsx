import { cloneElement, isValidElement, type ButtonHTMLAttributes, type ReactElement } from 'react'
import { cx } from '@/components/cx'

const variants = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
} as const

const sizes = {
  default: 'h-10 px-4 py-2',
  sm: 'h-9 rounded-none px-3',
  icon: 'h-10 w-10',
} as const

const base =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-none text-[13px] font-medium ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof variants
  size?: keyof typeof sizes
  asChild?: boolean
}

export function Button({ className, variant = 'default', size = 'default', asChild = false, children, ...props }: ButtonProps) {
  const classes = cx(base, variants[variant], sizes[size], className)
  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<{ className?: string }>
    return cloneElement(child, { className: cx(classes, child.props.className) })
  }
  return <button className={classes} {...props}>{children}</button>
}
