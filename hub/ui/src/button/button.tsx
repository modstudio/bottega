import type { ButtonHTMLAttributes, ReactElement, Ref } from 'react'
import { renderAs } from '../dom/render'
import { buttonStyles, iconButtonStyles, textButtonStyles } from './button.styles.ts'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md' | 'lg'

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
      className={buttonStyles({ variant, size, class: className })}
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
      className={iconButtonStyles({ variant, size, class: className })}
    />,
  )
}

/**
 * A button that sits inside a sentence: it inherits the surrounding size and
 * color and is marked by its underline, because a control with its own height
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
  return <button {...props} type={type} className={textButtonStyles({ class: className })} />
}
