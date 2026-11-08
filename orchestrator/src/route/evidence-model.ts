// concern: routing evidence model
/** Decides which effective model identity owns routing evidence. */

const OPENROUTER_HOST = 'openrouter.ai'
const ROUTING_VARIANTS = ['floor', 'nitro', 'exacto'] as const
const ROUTING_VARIANT_SET = new Set<string>(ROUTING_VARIANTS)

export function isOpenRouterBaseUrl(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false
  try {
    return new URL(baseUrl).hostname === OPENROUTER_HOST
  } catch {
    return false
  }
}

/** OpenRouter routing variants select providers, while every other suffix remains model identity. */
export function evidenceModel(model: string, baseUrl: string | null | undefined): string {
  if (!isOpenRouterBaseUrl(baseUrl)) return model
  const [name, ...variants] = model.split(':')
  return [name, ...variants.filter((variant) => !ROUTING_VARIANT_SET.has(variant))].join(':')
}

/** SQL form of evidenceModel for persisted run models already scoped by an OpenRouter agent row. */
export function evidenceModelSql(model: string, openRouter: string): string {
  const withSentinel = ROUTING_VARIANTS.reduce(
    (expression, variant) => `replace(${expression}, ':${variant}:', ':')`,
    `(${model} || ':')`,
  )
  return `CASE WHEN ${openRouter} THEN substr(${withSentinel}, 1, length(${withSentinel}) - 1) ELSE ${model} END`
}
