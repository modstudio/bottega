import { z } from 'zod'

export const email = z.string().trim().toLowerCase().email()
export const spaceId = z.string().uuid()
