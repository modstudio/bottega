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
    <fieldset className="m-0 inline-flex min-w-0 gap-0.5 border border-border-default bg-surface-sunken p-0.5">
      <legend className="sr-only">{label}</legend>
      {options.map(({ icon: Icon, ...option }) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={classes(
            'inline-flex items-center gap-1.5 border border-transparent px-3 text-text-muted [&_svg]:size-3.5 tabular-nums hover:text-text-primary aria-pressed:border-border-default aria-pressed:bg-surface-page aria-pressed:font-medium aria-pressed:text-text-primary aria-pressed:shadow-raised',
            size === 'sm'
              ? 'h-[calc(var(--control-h-sm)-6px)] text-sm'
              : 'h-[calc(var(--control-h-md)-6px)]',
          )}
        >
          {Icon ? <Icon aria-hidden /> : null}
          {option.label}
        </button>
      ))}
    </fieldset>
  )
}
