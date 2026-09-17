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
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
  label: string
  size?: 'sm' | 'md'
}) {
  return (
    <fieldset className="m-0 inline-flex min-w-0 border border-border-default p-0">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={classes(
            'border-border-default border-l px-3 text-text-secondary tabular-nums first:border-l-0 hover:bg-control-hover hover:text-text-primary aria-pressed:bg-surface-sunken aria-pressed:font-medium aria-pressed:text-text-primary',
            size === 'sm' ? 'h-control-sm text-sm' : 'h-control-md',
          )}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  )
}
