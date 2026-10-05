/** Values accepted by every ship-to boundary. */
export const SHIP_TO_VALUES = ['branch', 'trunk', 'production'] as const

export type ShipToValue = (typeof SHIP_TO_VALUES)[number]

export const isShipToValue = (value: unknown): value is ShipToValue =>
  typeof value === 'string' && SHIP_TO_VALUES.includes(value as ShipToValue)

/** Map a stored ship-to value, including accepted stored aliases, to its level. */
export function storedShipToLevel(value: unknown): ShipToValue | undefined {
  if (isShipToValue(value)) return value
  if (value === 'push') return 'branch'
  if (value === 'land') return 'trunk'
  if (value === 'promote') return 'production'
  return undefined
}
