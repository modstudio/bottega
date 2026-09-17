import type { ButtonHTMLAttributes, ReactElement, Ref } from 'react'
import { renderAs } from '../dom/render'
import { classes } from '../text/classes'

const variants = {
  primary: 'bg-accent-fill text-accent-on-fill hover:bg-accent-fill-hover',
  secondary:
    'border border-border-default bg-surface-page text-text-primary hover:bg-control-hover active:bg-control-pressed',
  ghost: 'text-text-primary hover:bg-control-hover active:bg-control-pressed',
  danger: 'bg-status-fill text-status-on-fill hover:bg-status-fill-hover',
} as const

const sizes = {
  sm: 'h-control-sm gap-1.5 px-2.5 text-sm [&_svg]:size-3.5',
  md: 'h-control-md gap-2 px-3.5 text-base [&_svg]:size-4',
  lg: 'h-control-lg gap-2 px-5 text-md [&_svg]:size-4',
} as const

const iconSizes = {
  sm: 'size-(--control-h-sm) [&_svg]:size-3.5',
  md: 'size-(--control-h-md) [&_svg]:size-4',
  lg: 'size-(--control-h-lg) [&_svg]:size-5',
} as const

type ButtonVariant = keyof typeof variants
type ButtonSize = keyof typeof sizes

const base =
  'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium transition-colors duration-(--duration-fast) disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0'

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & {
  ref?: Ref<HTMLButtonElement>
  variant?: ButtonVariant
  size?: ButtonSize
  /** An element to render as instead of a button, such as a router link. */
  render?: ReactElement<{ className?: string }>
  /** Layout only: margin, width and placement. */
  className?: string
}

export function Button({
  variant = 'secondary',
  size = 'md',
  render,
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return renderAs(
    render,
    <button
      {...props}
      type={render ? undefined : type}
      data-tone={variant === 'danger' ? 'error' : undefined}
      className={classes(base, variants[variant], sizes[size], className)}
    />,
  )
}

type IconButtonProps = Omit<ButtonProps, 'children' | 'aria-label'> & {
  /** Names the action for assistive technology and the tooltip. */
  label: string
  children: ReactElement
}

/** A square button holding only an icon; `label` names it. */
export function IconButton({
  variant = 'ghost',
  size = 'md',
  label,
  render,
  className,
  type = 'button',
  ...props
}: IconButtonProps) {
  return renderAs(
    render,
    <button
      {...props}
      type={render ? undefined : type}
      aria-label={label}
      title={label}
      data-tone={variant === 'danger' ? 'error' : undefined}
      className={classes(base, variants[variant], iconSizes[size], className)}
    />,
  )
}

/**
 * A button that sits inside a sentence: it inherits the surrounding size and
 * colour and is marked by its underline, because a control with its own height
 * and padding would break the line it belongs to.
 */
export function TextButton({
  className,
  type = 'button',
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & {
  ref?: Ref<HTMLButtonElement>
  /** Layout only: margin and placement. */
  className?: string
}) {
  return (
    <button
      {...props}
      type={type}
      className={classes(
        'cursor-pointer underline decoration-border-strong underline-offset-2 hover:decoration-current disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
    />
  )
}
