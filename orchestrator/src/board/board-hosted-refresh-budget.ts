// concern: hosted-board-refresh-budget
/** Runs one hosted-board refresh operation within its remaining budget. */

export const BUDGET_SPENT = 'hosted board refresh budget spent'

export async function withinHostedBoardRefreshBudget<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  remainingMs: number,
): Promise<T> {
  if (remainingMs <= 0) throw new Error(BUDGET_SPENT)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation(controller.signal).catch((error: unknown) => {
        if (controller.signal.aborted) throw new Error(BUDGET_SPENT)
        throw error
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(BUDGET_SPENT))
        }, remainingMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
