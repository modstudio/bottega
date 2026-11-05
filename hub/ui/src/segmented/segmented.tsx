import type { LucideIcon } from 'lucide-react'
import { useControlSize } from '../field/control-size'
import { segmentedOptionStyles, segmentedStyles } from './segmented.styles.ts'

/** One choice from a few short options, all visible at once. */
export function Segmented({
  value,
  options,
  onChange,
  label,
  size: own,
}: {
  value: string
  options: readonly { value: string; label: string; icon?: LucideIcon }[]
  onChange: (value: string) => void
  label: string
  size?: 'sm' | 'md'
}) {
  const size = useControlSize(own, 'sm')
  return (
    <fieldset className={segmentedStyles({ size }).root()}>
      <legend className={segmentedStyles().legend()}>{label}</legend>
      {options.map(({ icon: Icon, ...option }) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={segmentedOptionStyles({ size })}
        >
          {Icon ? <Icon aria-hidden /> : null}
          {option.label}
        </button>
      ))}
    </fieldset>
  )
}
