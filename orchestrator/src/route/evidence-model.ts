// concern: routing evidence model
/** Decides which effective model identity owns routing evidence. */

import { isOpenRouterBaseUrl } from '../agent/openrouter.ts'

const ROUTING_VARIANTS = ['floor', 'nitro', 'exacto'] as const
const ROUTING_VARIANT_SET = new Set<string>(ROUTING_VARIANTS)

export type EvidenceModelIdentity = {
  model: string | null | undefined
  openRouter: 0 | 1
}

/** Decides the normalized model and provider flag consumed together by evidence queries. */
export function evidenceModelIdentity(
  model: string,
  baseUrl: string | null | undefined,
): EvidenceModelIdentity & { model: string }
export function evidenceModelIdentity(
  model: string | null | undefined,
  baseUrl: string | null | undefined,
): EvidenceModelIdentity
export function evidenceModelIdentity(
  model: string | null | undefined,
  baseUrl: string | null | undefined,
): EvidenceModelIdentity {
  const openRouter = isOpenRouterBaseUrl(baseUrl) ? 1 : 0
  if (!openRouter || model == null) return { model, openRouter }
  const [name, ...variants] = model.split(':')
  return {
    model: [name, ...variants.filter((variant) => !ROUTING_VARIANT_SET.has(variant))].join(':'),
    openRouter,
  }
}

/** OpenRouter routing variants select providers, while every other suffix remains model identity. */
export function evidenceModel(model: string, baseUrl: string | null | undefined): string {
  return evidenceModelIdentity(model, baseUrl).model
}

/** SQL form of evidenceModel for persisted run models already scoped by an OpenRouter agent row. */
export function evidenceModelSql(model: string, openRouter: string): string {
  const jsonSegments = `'["' || replace(substr(json_quote(${model}), 2, length(json_quote(${model})) - 2), ':', '","') || '"]'`
  const routingVariants = ROUTING_VARIANTS.map((variant) => `'${variant}'`).join(',')
  return `CASE WHEN ${model} IS NULL THEN NULL WHEN ${openRouter} THEN (SELECT group_concat(value, ':') FROM json_each(${jsonSegments}) WHERE key = 0 OR value NOT IN (${routingVariants})) ELSE ${model} END`
}
