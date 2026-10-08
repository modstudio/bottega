import { workerStoreWriteRefusal } from '../worker-store-write.ts'

export function assertWorkerDocStoreWriteAllowed(operation: string): void {
  const refusal = workerStoreWriteRefusal('document', operation, process.env)
  if (refusal) throw new Error(refusal)
}
