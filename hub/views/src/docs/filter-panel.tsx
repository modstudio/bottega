import { TextButton } from '@bottega/hub-ui/button'
import { RadioIndicator } from '@bottega/hub-ui/radio-rows'
import { Switch } from '@bottega/hub-ui/switch'
import { useId } from 'react'
import { filterPanelStyles } from './filter-panel.styles.ts'
import {
  EMPTY_FILTERS,
  type FilterKey,
  type FilterSelection,
  type OfferedFilter,
} from './filters.ts'

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
    <label className={filterPanelStyles().audienceOption()}>
      <input
        className={filterPanelStyles().input()}
        type="radio"
        name={name}
        checked={checked}
        onChange={onSelect}
      />
      <RadioIndicator selected={checked} />
      <span>{label}</span>
      <span className={filterPanelStyles().optionCount()}>{count}</span>
    </label>
  )
}

export function FilterPanel({
  offered,
  chosen,
  onChange,
  total,
  drafts,
  working,
}: {
  offered: OfferedFilter[]
  chosen: FilterSelection
  onChange: (next: FilterSelection) => void
  total: number
  /** The drafts switch, or null where the reader may not see drafts. */
  drafts: { shown: boolean; onChange: (shown: boolean) => void } | null
  /** The working-document switch, or null where it does not apply. */
  working: { shown: boolean; onChange: (shown: boolean) => void } | null
}) {
  const draftsId = useId()
  const workingId = useId()
  const labels: Record<FilterKey, string> = {
    audience: 'Audience',
    scope: 'Scope',
    delivery: 'Delivery',
  }
  const active = Boolean(chosen.audience || chosen.scope || chosen.delivery)
  return (
    <div className={filterPanelStyles().panel()}>
      {offered.map((filter) => (
        // A legend sits on its fieldset's border, so the rule between groups belongs to a wrapper.
        <div key={filter.key} className={filterPanelStyles().group()}>
          <fieldset className={filterPanelStyles().fieldset()}>
            <legend className={filterPanelStyles().legend()}>{labels[filter.key]}</legend>
            <FilterOption
              name={`docs-filter-${filter.key}`}
              checked={chosen[filter.key] === null}
              label={filter.allLabel}
              count={total}
              onSelect={() => onChange({ ...chosen, [filter.key]: null })}
            />
            {filter.options.map((option) => (
              <FilterOption
                key={option.value}
                name={`docs-filter-${filter.key}`}
                checked={chosen[filter.key] === option.value}
                label={option.label}
                count={option.count}
                onSelect={() => onChange({ ...chosen, [filter.key]: option.value })}
              />
            ))}
          </fieldset>
        </div>
      ))}
      {drafts ? (
        <label htmlFor={draftsId} className={filterPanelStyles().draftsOption()}>
          Show drafts
          <Switch
            id={draftsId}
            aria-label="Show drafts"
            checked={drafts.shown}
            onChange={(event) => drafts.onChange(event.currentTarget.checked)}
          />
        </label>
      ) : null}
      {working ? (
        <label htmlFor={workingId} className={filterPanelStyles().workingOption()}>
          Show working documents
          <Switch
            id={workingId}
            aria-label="Show working documents"
            checked={working.shown}
            onChange={(event) => working.onChange(event.currentTarget.checked)}
          />
        </label>
      ) : null}
      {offered.length ? (
        <div className={filterPanelStyles().actions()}>
          <span>Only filters these docs can use</span>
          {active ? <TextButton onClick={() => onChange(EMPTY_FILTERS)}>Clear</TextButton> : null}
        </div>
      ) : null}
    </div>
  )
}
