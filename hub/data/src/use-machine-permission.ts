import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { queryClient, trpc } from './client.ts'

export type MachinePermissionChange = {
  operation: 'add' | 'remove' | 'drop' | 'undrop'
  list: 'allow' | 'ask' | 'deny'
  rule: string
}

export function useMachinePermissionChange() {
  const mutation = useMutation(trpc.context.settings.machinePermission.mutationOptions())
  const [pending, setPending] = useState(false)
  return {
    async run(input: MachinePermissionChange, { onApplied }: { onApplied(): void }) {
      setPending(true)
      try {
        await mutation.mutateAsync(input)
      } catch {
        setPending(false)
        return false
      }

      onApplied()
      try {
        await queryClient.invalidateQueries({ queryKey: trpc.context.settings.pathKey() })
      } catch {
        // The write was committed. A failed refresh must not report it as failed.
      } finally {
        setPending(false)
      }
      return true
    },
    pending,
    error: mutation.error?.message ?? null,
  }
}
