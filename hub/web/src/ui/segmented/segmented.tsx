import type { LucideIcon } from 'lucide-react'
import { classes } from '../text/classes'

/** One choice from a few short options, all visible at once. */
export function Segmented({
  value,
  options,
  onChange,
  label,
  size = 'sm',
}: {
  value: string
  options: readonly { value: string; label: string; icon?: LucideIcon }[]
  onChange: (value: string) => void
  label: string
  size?: 'sm' | 'md'
}) {
  return (
    <fieldset
      className={classes(
        'm-0 inline-flex min-w-0 overflow-hidden border border-border-default p-0',
        size === 'sm' ? 'h-control-sm' : 'h-control-md',
      )}
    >
      <legend className="sr-only">{label}</legend>
      {options.map(({ icon: Icon, ...option }) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={classes(
            'inline-flex items-center gap-1.5 border-border-default border-l bg-surface-sunken px-3 text-text-muted tabular-nums first-of-type:border-l-0 hover:text-text-primary [&_svg]:size-3.5 [&_svg]:text-border-strong [&_svg]:opacity-80',
            'aria-pressed:bg-surface-page aria-pressed:font-medium aria-pressed:text-text-primary aria-pressed:[&_svg]:text-text-secondary',
            size === 'sm' ? 'h-full text-sm' : 'h-full',
          )}
        >
          {Icon ? <Icon aria-hidden /> : null}
          {option.label}
        </button>
      ))}
    </fieldset>
  )
}
