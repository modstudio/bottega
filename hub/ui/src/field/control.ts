import { createElement, type ReactNode, useId } from 'react'

/**
 * The one look every text-entry control shares: border, surface, focus and
 * invalid states. Input, Textarea, the listbox trigger and SearchField use it.
 */
export const controlClasses =
  'min-w-0 border border-border-default bg-surface-page text-base text-text-primary transition-colors duration-(--duration-fast) placeholder:text-text-muted hover:border-border-strong focus-visible:border-focus focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-control-disabled disabled:text-text-disabled aria-invalid:border-(--status-error) [&::-webkit-search-cancel-button]:hidden'

const fieldHintClasses = 'text-sm text-text-muted'

/** Gives a control's hint a stable id while preserving any existing description. */
export function useFieldHint(hint: ReactNode, describedBy?: string) {
  const hintId = useId()
  return {
    hintId,
    describedBy: [describedBy, hint ? hintId : undefined].filter(Boolean).join(' ') || undefined,
  }
}

export function FieldHint({
  id,
  as = 'span',
  children,
}: {
  id: string
  as?: 'span' | 'div'
  children?: ReactNode
}) {
  return createElement(as, { id, className: fieldHintClasses }, children)
}

/** Places shared help immediately below a control. */
export function ControlWithHint({
  className,
  control,
  hint,
  hintId,
}: {
  className: string
  control: ReactNode
  hint: ReactNode
  hintId: string
}) {
  if (!hint) return control
  return createElement(
    'span',
    { className },
    control,
    createElement(FieldHint, { id: hintId }, hint),
  )
}
