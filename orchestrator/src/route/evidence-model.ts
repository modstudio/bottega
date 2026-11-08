// concern: routing evidence model
/** Decides which effective model identity owns routing evidence. */

import { isOpenRouterBaseUrl } from '../agent/openrouter.ts'

const ROUTING_VARIANTS = ['floor', 'nitro', 'exacto'] as const
const ROUTING_VARIANT_SET = new Set<string>(ROUTING_VARIANTS)

export { isOpenRouterBaseUrl } from '../agent/openrouter.ts'

/** OpenRouter routing variants select providers, while every other suffix remains model identity. */
export function evidenceModel(model: string, baseUrl: string | null | undefined): string {
  if (!isOpenRouterBaseUrl(baseUrl)) return model
  const [name, ...variants] = model.split(':')
  return [name, ...variants.filter((variant) => !ROUTING_VARIANT_SET.has(variant))].join(':')
}

/** SQL form of evidenceModel for persisted run models already scoped by an OpenRouter agent row. */
export function evidenceModelSql(model: string, openRouter: string): string {
  const jsonSegments = `'["' || replace(substr(json_quote(${model}), 2, length(json_quote(${model})) - 2), ':', '","') || '"]'`
  const routingVariants = ROUTING_VARIANTS.map((variant) => `'${variant}'`).join(',')
  return `CASE WHEN ${openRouter} THEN (SELECT group_concat(value, ':') FROM json_each(${jsonSegments}) WHERE value NOT IN (${routingVariants})) ELSE ${model} END`
}
