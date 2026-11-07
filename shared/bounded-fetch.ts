import ky, { isResponseSizeError, isTimeoutError } from 'ky'
import { BoundExceededError, CALL_BUDGETS, type CallBudgetName } from './call-budgets.ts'

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

export function boundedFetch(budgetName: CallBudgetName): typeof fetch {
  const budget = CALL_BUDGETS[budgetName]
  const fetchWithBounds = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input)
    try {
      const response = await ky(input, {
        ...init,
        timeout: budget.deadlineMs,
        totalTimeout: budget.totalMs ?? budget.deadlineMs,
        retry: 0,
        maxResponseSize: budget.outputBytes,
        throwHttpErrors: false,
      })
      const body = await response.arrayBuffer()
      const rebuilt = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
      Object.defineProperties(rebuilt, {
        url: { value: response.url },
        redirected: { value: response.redirected },
        type: { value: response.type },
      })
      return rebuilt
    } catch (error) {
      if (init?.signal?.aborted) init.signal.throwIfAborted()
      if (input instanceof Request && input.signal.aborted) input.signal.throwIfAborted()
      if (isResponseSizeError(error)) {
        throw new BoundExceededError(url, budgetName, 'output', budget.outputBytes)
      }
      if (isTimeoutError(error)) {
        throw new BoundExceededError(url, budgetName, 'deadline', budget.deadlineMs)
      }
      throw error
    }
  }
  return Object.assign(fetchWithBounds, { preconnect: fetch.preconnect })
}
