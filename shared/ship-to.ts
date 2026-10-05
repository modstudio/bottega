/** Values accepted by every ship-to boundary. */
export const SHIP_TO_VALUES = ['branch', 'trunk', 'production'] as const

export type ShipToValue = (typeof SHIP_TO_VALUES)[number]

export const SHIP_TO_CONFIG_KEY = 'autonomy.ship-to'
export const STORED_SHIP_TO_CONFIG_ALIAS = 'autonomy.release'

export const isShipToConfigKey = (key: string): boolean =>
  key === SHIP_TO_CONFIG_KEY || key === STORED_SHIP_TO_CONFIG_ALIAS

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

export type StoredShipToRead = {
  level?: ShipToValue
  invalid?: unknown
}

/** Read the two stored key spellings into the internal ship-to level. */
export function readStoredShipTo(
  shipTo: unknown,
  release: unknown,
  hasShipTo = shipTo !== undefined,
  hasRelease = release !== undefined,
): StoredShipToRead {
  if (hasShipTo) {
    const level = storedShipToLevel(shipTo)
    if (level !== undefined) return { level }
    if (hasRelease) {
      const aliasLevel = storedShipToLevel(release)
      if (aliasLevel !== undefined) return { level: aliasLevel, invalid: shipTo }
    }
    return { invalid: shipTo }
  }
  if (hasRelease) {
    const level = storedShipToLevel(release)
    return level === undefined ? { invalid: release } : { level }
  }
  return {}
}
