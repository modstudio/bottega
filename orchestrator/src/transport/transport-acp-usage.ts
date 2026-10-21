// concern: ACP metered usage
/** Folds run-local goose message usage without knowing transport lifecycle or persistence. */
import type { VendorCostSource, VendorUsage } from './transport.ts'
import type { AcpMessageUsageUpdate, AcpPromptUsage } from './transport-acp.ts'

type MessageTotals = {
  inputTokens: number
  outputTokens: number
  hasInputTokens: boolean
  hasOutputTokens: boolean
  cost: number
  costMessages: number
  providerCostMessages: number
}

function messageTotals(updates: AcpMessageUsageUpdate[]): MessageTotals {
  const totals: MessageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    hasInputTokens: false,
    hasOutputTokens: false,
    cost: 0,
    costMessages: 0,
    providerCostMessages: 0,
  }
  for (const update of updates) {
    if (!update.usage) continue
    const usage = update.usage
    if (typeof usage.inputTokens === 'number') {
      totals.inputTokens += usage.inputTokens
      totals.hasInputTokens = true
    }
    if (typeof usage.outputTokens === 'number') {
      totals.outputTokens += usage.outputTokens
      totals.hasOutputTokens = true
    }
    if (typeof usage.cost !== 'number') continue
    totals.cost += usage.cost
    totals.costMessages += 1
    if (usage.costSource === 'provider_reported') totals.providerCostMessages += 1
  }
  return totals
}

function costSource(totals: MessageTotals, promptCost: number | null): VendorCostSource {
  if (totals.costMessages === 0) return promptCost === null ? 'none' : 'estimated'
  if (totals.providerCostMessages === totals.costMessages) return 'billed'
  return totals.providerCostMessages === 0 ? 'estimated' : 'partial'
}

export function acpRunUsage(updates: AcpMessageUsageUpdate[], prompt: AcpPromptUsage) {
  const messages = messageTotals(updates)
  const promptInput = typeof prompt?.inputTokens === 'number' ? prompt.inputTokens : null
  const promptOutput = typeof prompt?.outputTokens === 'number' ? prompt.outputTokens : null
  const promptTotal = typeof prompt?.totalTokens === 'number' ? prompt.totalTokens : null
  const promptCost = typeof prompt?.costUsd === 'number' ? prompt.costUsd : null
  const inputTokens = messages.hasInputTokens ? messages.inputTokens : promptInput
  const outputTokens = messages.hasOutputTokens ? messages.outputTokens : promptOutput
  const tokens =
    inputTokens !== null || outputTokens !== null
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : promptTotal
  const source = costSource(messages, promptCost)
  const billedCostUsd = source === 'billed' ? messages.cost : null
  const estimatedCostUsd =
    source === 'partial' || source === 'estimated'
      ? messages.costMessages > 0
        ? messages.cost
        : promptCost
      : null
  const vendorUsage: VendorUsage = {
    inputTokens,
    outputTokens,
    estimatedCostUsd,
    costSource: source,
  }
  return { tokens, costUsd: billedCostUsd, vendorUsage }
}
