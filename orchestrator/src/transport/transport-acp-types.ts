// concern: ACP usage protocol values

export type AcpMessageUsage = {
  inputTokens?: number | null
  outputTokens?: number | null
  totalTokens?: number | null
  cost?: number | null
  costSource?: 'provider_reported' | 'estimated' | null
}

export type AcpMessageUsageUpdate = {
  sessionUpdate: 'message_usage'
  usage?: AcpMessageUsage
}

export type AcpPromptUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  costUsd?: number
} | null
