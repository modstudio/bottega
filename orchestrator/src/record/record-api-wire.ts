// concern: record-api-wire
/** Owns the hosted record API's shared wire encodings and identifiers. */

import { z } from 'zod'
import { MACHINE_KEY_ID_PATTERN } from './record-config.ts'

export const idSchema = z.string().uuid()
export const keyIdSchema = z.string().regex(MACHINE_KEY_ID_PATTERN)
export const base64urlSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((value) => Buffer.from(value, 'base64url').toString('base64url') === value)

export const encoded = (value: Uint8Array): string => Buffer.from(value).toString('base64url')
export const decoded = (value: string): Uint8Array =>
  new Uint8Array(Buffer.from(value, 'base64url'))
