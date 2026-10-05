/** Values accepted by every ship-to boundary. */
export const SHIP_TO_VALUES = ['branch', 'trunk', 'production'] as const

export type ShipToValue = (typeof SHIP_TO_VALUES)[number]

/** Map a stored ship-to value, including accepted stored aliases, to its level. */
export function storedShipToLevel(value: unknown): ShipToValue | undefined {
  if (value === 'branch' || value === 'push') return 'branch'
  if (value === 'trunk' || value === 'land') return 'trunk'
  if (value === 'production' || value === 'promote') return 'production'
  return undefined
}

export const isShipToValue = (value: unknown): value is ShipToValue =>
  typeof value === 'string' && SHIP_TO_VALUES.includes(value as ShipToValue)
