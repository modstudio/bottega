import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { type ConfigEnvironment, resolveConfigRoot } from './config-directory.ts'
import { machineKeyId } from './secret-envelope.ts'

const entrySchema = z
  .object({
    public_key: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .refine((value) => Buffer.from(value, 'base64url').toString('base64url') === value),
    label: z.string(),
    pinned_at: z.string().datetime({ offset: true }),
  })
  .strict()
const listSchema = z.record(z.string(), entrySchema)

type TrustedMachine = z.infer<typeof entrySchema>
export type TrustList = Record<string, TrustedMachine>

export function trustListPath(env: ConfigEnvironment = process.env): string {
  return join(resolveConfigRoot(env), 'trusted-machines.toml')
}

export async function readTrustList(env: ConfigEnvironment = process.env): Promise<TrustList> {
  const path = trustListPath(env)
  let parsed: unknown
  try {
    parsed = Bun.TOML.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`refusing trust list ${path}: ${detail}`)
  }
  const result = listSchema.safeParse(parsed)
  if (!result.success) throw new Error(`refusing trust list ${path}: invalid schema`)
  for (const [keyId, entry] of Object.entries(result.data)) {
    const publicKey = new Uint8Array(Buffer.from(entry.public_key, 'base64url'))
    if (publicKey.length !== 32 || (await machineKeyId(publicKey)) !== keyId) {
      throw new Error(`refusing trust list ${path}: key id ${keyId} does not match its public key`)
    }
  }
  return result.data
}

function toml(list: TrustList): string {
  return `${Object.entries(list)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([id, entry]) =>
        `[${JSON.stringify(id)}]\npublic_key = ${JSON.stringify(entry.public_key)}\nlabel = ${JSON.stringify(entry.label)}\npinned_at = ${JSON.stringify(entry.pinned_at)}\n`,
    )
    .join('\n')}\n`
}

function writeTrustList(list: TrustList, env: ConfigEnvironment = process.env): void {
  const root = resolveConfigRoot(env)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const path = trustListPath(env)
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, toml(list), { mode: 0o600 })
  renameSync(temporary, path)
}

export async function pinTrustedMachine(
  keyId: string,
  publicKey: Uint8Array,
  label: string,
  env: ConfigEnvironment = process.env,
): Promise<void> {
  if ((await machineKeyId(publicKey)) !== keyId)
    throw new Error('machine key id does not match public key')
  const list = await readTrustList(env)
  writeTrustList(
    {
      ...list,
      [keyId]: {
        public_key: Buffer.from(publicKey).toString('base64url'),
        label,
        pinned_at: new Date().toISOString(),
      },
    },
    env,
  )
}

export async function unpinTrustedMachine(
  keyId: string,
  env: ConfigEnvironment = process.env,
): Promise<void> {
  const list = await readTrustList(env)
  delete list[keyId]
  writeTrustList(list, env)
}
