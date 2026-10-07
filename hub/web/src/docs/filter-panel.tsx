import { TextButton } from '@/ui/button/button'
import { RadioIndicator } from '@/ui/radio-rows/radio-rows'
import { classes } from '@/ui/text/classes'
import {
  EMPTY_FILTERS,
  type FilterKey,
  type FilterSelection,
  type OfferedFilter,
} from './filters.ts'

const eyebrow = 'font-mono text-text-muted text-xs tracking-[0.14em] uppercase'

function FilterOption({
  name,
  checked,
  label,
  count,
  onSelect,
}: {
  name: string
  checked: boolean
  label: string
  count: number
  onSelect: () => void
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-1 text-md text-text-secondary">
      <input className="sr-only" type="radio" name={name} checked={checked} onChange={onSelect} />
      <RadioIndicator selected={checked} />
      <span>{label}</span>
      <span className="ml-auto font-mono text-text-muted text-xs">{count}</span>
    </label>
  )
}

export function FilterPanel({
  offered,
  chosen,
  onChange,
  total,
}: {
  offered: OfferedFilter[]
  chosen: FilterSelection
  onChange: (next: FilterSelection) => void
  total: number
}) {
  const labels: Record<FilterKey, string> = { scope: 'Scope', delivery: 'Delivery' }
  const active = Boolean(chosen.scope || chosen.delivery)
  return (
    <div className="w-[min(17.5rem,calc(100vw-2.5rem))]">
      {offered.map((filter) => (
        // A legend sits on its fieldset's border, so the rule between groups belongs to a wrapper.
        <div
          key={filter.key}
          className="mt-3 border-border-default border-t pt-3 first:mt-0 first:border-t-0 first:pt-0"
        >
          <fieldset className="m-0 border-0 p-0">
            <legend className={classes(eyebrow, 'mb-1.5 px-0')}>{labels[filter.key]}</legend>
            <FilterOption
              name={`docs-filter-${filter.key}`}
              checked={chosen[filter.key] === null}
              label="Any"
              count={total}
              onSelect={() => onChange({ ...chosen, [filter.key]: null })}
            />
            {filter.options.map((option) => (
              <FilterOption
                key={option.value}
                name={`docs-filter-${filter.key}`}
                checked={chosen[filter.key] === option.value}
                label={option.value}
                count={option.count}
                onSelect={() => onChange({ ...chosen, [filter.key]: option.value })}
              />
            ))}
          </fieldset>
        </div>
      ))}
      <div className="mt-3 flex justify-between border-border-default border-t pt-2.5 text-sm text-text-muted">
        <span>Only filters these docs can use</span>
        {active ? <TextButton onClick={() => onChange(EMPTY_FILTERS)}>Clear</TextButton> : null}
      </div>
    </div>
  )
}
