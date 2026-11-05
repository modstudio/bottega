import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import type { MachinePermissionOperation } from '../../../shared/machine-config.ts'
import type { SettingsPermissionList } from '../../../shared/settings-permission-lists.ts'
import { queryClient, trpc } from './client.ts'

export type MachinePermissionChange = {
  operation: MachinePermissionOperation
  list: SettingsPermissionList
  rule: string
}

export function useMachinePermissionChange() {
  const mutation = useMutation(trpc.context.settings.machinePermission.mutationOptions())
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return {
    async run(input: readonly MachinePermissionChange[]) {
      setPending(true)
      setError(null)
      let saved = 0
      try {
        for (const step of input) {
          await mutation.mutateAsync(step)
          saved += 1
        }
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure)
        setError(message)
        return { saved, error: message }
      } finally {
        try {
          await queryClient.invalidateQueries({ queryKey: trpc.context.settings.pathKey() })
        } catch {
          // The writes were committed. A failed refresh must not report them as failed.
        } finally {
          setPending(false)
        }
      }
      return { saved, error: null }
    },
    pending,
    error,
  }
}
