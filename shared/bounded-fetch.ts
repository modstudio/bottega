import ky, { isResponseSizeError, isTimeoutError } from 'ky'
import { BoundExceededError, CALL_BUDGETS, type CallBudgetName } from './call-budgets.ts'

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function requestOptions(input: RequestInfo | URL, init?: RequestInit): RequestInit | undefined {
  if (!(input instanceof Request)) return init
  return {
    ...init,
    cache: init?.cache ?? input.cache,
    credentials: init?.credentials ?? input.credentials,
    headers: init?.headers ?? input.headers,
    integrity: init?.integrity ?? input.integrity,
    keepalive: init?.keepalive ?? input.keepalive,
    method: init?.method ?? input.method,
    mode: init?.mode ?? input.mode,
    redirect: init?.redirect ?? input.redirect,
    referrer: init?.referrer ?? input.referrer,
    referrerPolicy: init?.referrerPolicy ?? input.referrerPolicy,
    signal: init?.signal ?? input.signal,
  }
}

export function boundedFetch(budgetName: CallBudgetName): typeof fetch {
  const budget = CALL_BUDGETS[budgetName]
  const fetchWithBounds = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input)
    const options = requestOptions(input, init)
    const transport = globalThis.fetch
    try {
      const response = await ky(input, {
        ...options,
        fetch: (request, transportInit) =>
          transport(request, {
            ...transportInit,
            cache: options?.cache,
            credentials: options?.credentials,
            integrity: options?.integrity,
            keepalive: options?.keepalive,
            mode: options?.mode,
            redirect: options?.redirect,
            referrer: options?.referrer,
            referrerPolicy: options?.referrerPolicy,
          }),
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
