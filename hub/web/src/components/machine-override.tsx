import { type ReactNode, useState } from 'react'
import { Badge } from '@/ui/badge/badge'
import { Button, TextButton } from '@/ui/button/button'
import { Select } from '@/ui/listbox/select'

/**
 * The opt-in every machine override shares: a setting follows the profile until the
 * operator asks to override it here, so nothing shows where no override exists.
 * `close` returns an opened but still empty override to that resting state.
 */
export function MachineOptIn({
  active,
  children,
}: {
  /** Whether an override already exists on this machine. */
  active: boolean
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  if (!active && !open) {
    return (
      <TextButton className="self-start" onClick={() => setOpen(true)}>
        Override on this machine
      </TextButton>
    )
  }
  return children(() => setOpen(false))
}

/** One setting's value on this machine, with the action that removes it. */
export function MachineOverride({
  label,
  value,
  options,
  pending,
  onSet,
  onRemove,
}: {
  label: string
  value: string | undefined
  options: readonly { value: string; label: string }[]
  pending: boolean
  onSet(value: string): void
  onRemove(): void
}) {
  return (
    <MachineOptIn active={value !== undefined}>
      {(close) => (
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone="info">This machine</Badge>
          <Select
            label={`${label} on this machine`}
            size="sm"
            value={value ?? ''}
            options={options}
            onChange={onSet}
          />
          {value === undefined ? (
            <Button size="sm" variant="ghost" onClick={close}>
              Cancel
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                close()
                onRemove()
              }}
            >
              Remove
            </Button>
          )}
        </span>
      )}
    </MachineOptIn>
  )
}
