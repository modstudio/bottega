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
    <fieldset className={radioRowsStyles().slot1()}>
      <legend className={radioRowsStyles().slot2()}>{label}</legend>
      <div className={radioRowsStyles().slot3()}>
        {options.map((option) => {
          const selected = option.value === value
          return (
            <label key={option.value} className={radioRowsStyles({ selected }).option()}>
              <input
                className={radioRowsStyles().slot4()}
                type="radio"
                name={id}
                value={option.value}
                checked={selected}
                onChange={() => onChange(option.value)}
              />
              <RadioIndicator selected={selected} />
              <span className={radioRowsStyles().slot5()}>
                {option.label}
                {option.recommended ? (
                  <span className={radioRowsStyles().slot6()}>recommended</span>
                ) : null}
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
