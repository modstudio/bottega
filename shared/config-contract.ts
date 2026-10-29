import { z } from 'zod'
import type { ConfigEntry } from './config-client.ts'
import type { MachineConfigFileEntry } from './machine-config.ts'

export const ConfigEntrySchema = z.object({
  key: z.string(),
  environment: z.string(),
  scope: z.enum(['user', 'space']),
  value: z.string(),
  rowVersion: z.number(),
  updatedAt: z.string(),
}) satisfies z.ZodType<ConfigEntry>

export const MachineConfigFileEntrySchema = z.object({
  key: z.string(),
  value: z.string(),
  scope: z.literal('machine'),
}) satisfies z.ZodType<MachineConfigFileEntry>
