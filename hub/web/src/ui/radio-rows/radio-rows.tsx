import { useId } from 'react'
import { classes } from '../text/classes'

type RadioOption = { value: string; label: string; recommended?: boolean }

/** A radio group for long choices, with selection following focus per the APG pattern. */
export function RadioRows({
  value,
  options,
  onChange,
  label,
}: {
  value: string
  options: readonly RadioOption[]
  onChange: (value: string) => void
  label: string
}) {
  const id = useId()
  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="mb-2 font-medium text-sm">{label}</legend>
      <div className="space-y-2">
        {options.map((option) => {
          const selected = option.value === value
          return (
            <label
              key={option.value}
              className={classes(
                'flex w-full cursor-pointer items-start gap-3 border p-3 text-left transition-colors hover:bg-control-hover has-focus-visible:outline-2 has-focus-visible:outline-accent-fill has-focus-visible:outline-offset-2',
                selected
                  ? 'border-accent-fill bg-surface-page text-text-primary'
                  : 'border-border-default bg-surface-sunken text-text-secondary',
              )}
            >
              <input
                className="sr-only"
                type="radio"
                name={id}
                value={option.value}
                checked={selected}
                onChange={() => onChange(option.value)}
              />
              <span
                aria-hidden
                className={classes(
                  'mt-0.5 size-4 shrink-0 rounded-full border-4',
                  selected
                    ? 'border-accent-fill bg-surface-page'
                    : 'border-border-strong bg-surface-page',
                )}
              />
              <span className="min-w-0 flex-1">
                {option.label}
                {option.recommended ? (
                  <span className="ml-2 whitespace-nowrap text-accent-text text-sm">
                    recommended
                  </span>
                ) : null}
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
