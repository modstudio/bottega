import { useId } from 'react'
import { radioIndicatorStyles, radioRowsStyles } from './radio-rows.styles.ts'

type RadioOption = { value: string; label: string; recommended?: boolean }

/** The disc RadioRows and other radio rows share. */
export function RadioIndicator({ selected }: { selected: boolean }) {
  return <span aria-hidden className={radioIndicatorStyles({ selected })} />
}

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
    <fieldset className={radioRowsStyles().fieldset()}>
      <legend className={radioRowsStyles().legend()}>{label}</legend>
      <div className={radioRowsStyles().options()}>
        {options.map((option) => {
          const selected = option.value === value
          return (
            <label key={option.value} className={radioRowsStyles({ selected }).option()}>
              <input
                className={radioRowsStyles().input()}
                type="radio"
                name={id}
                value={option.value}
                checked={selected}
                onChange={() => onChange(option.value)}
              />
              <RadioIndicator selected={selected} />
              <span className={radioRowsStyles().label()}>
                {option.label}
                {option.recommended ? (
                  <span className={radioRowsStyles().recommended()}>recommended</span>
                ) : null}
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
