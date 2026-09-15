// concern: codex-schema
/** Owns Codex strict-schema adaptation. Must not know agents, registries, probes, or hosts. */
import { readFileSync } from 'node:fs'
type JSONSchema = Record<string, unknown>

const STRICT_UNSUPPORTED = new Set([
  'allOf',
  'not',
  'dependentRequired',
  'dependentSchemas',
  'if',
  'then',
  'else',
  'patternProperties',
  'oneOf',
])

const pathKey = (path: string, key: string) =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`

function isSchemaObject(value: unknown): value is JSONSchema {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function permitsNull(schema: JSONSchema): boolean {
  const type = schema.type
  if (type === 'null' || (Array.isArray(type) && type.includes('null'))) return true
  return (
    Array.isArray(schema.anyOf) &&
    schema.anyOf.some((part) => isSchemaObject(part) && permitsNull(part))
  )
}

function nullable(schema: JSONSchema): JSONSchema {
  if (permitsNull(schema)) return schema
  if (typeof schema.type === 'string') return { ...schema, type: [schema.type, 'null'] }
  if (Array.isArray(schema.type)) return { ...schema, type: [...schema.type, 'null'] }
  if (Array.isArray(schema.anyOf)) {
    return { ...schema, anyOf: [...schema.anyOf, { type: 'null' }] }
  }
  return { anyOf: [schema, { type: 'null' }] }
}

/**
 * Convert ordinary JSON Schema to the strict subset Codex passes to OpenAI
 * Structured Outputs.
 *
 * The documented rules checked here are: the root is an object (not anyOf or
 * oneOf); every object has additionalProperties:false and requires every named
 * property; optional fields use a null union; and unsupported allOf, oneOf,
 * not, dependentRequired, dependentSchemas, if/then/else and patternProperties
 * keywords are refused. Nested anyOf, $defs/definitions and recursion by $ref
 * remain supported. Keeping this list beside the transformer makes a vendor
 * change visible instead of spending another run to discover it.
 */
export function strictCodexSchema(input: unknown): JSONSchema {
  if (!isSchemaObject(input)) throw new Error('schema at $ must be a JSON object')
  if (input.type !== 'object') {
    const keyword = 'oneOf' in input ? 'oneOf' : 'anyOf' in input ? 'anyOf' : 'type'
    throw new Error(`schema at $.${keyword} must have an object root`)
  }

  const visit = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((item, i) => visit(item, `${path}[${i}]`))
    if (!isSchemaObject(value)) return value
    for (const key of Object.keys(value)) {
      if (STRICT_UNSUPPORTED.has(key)) {
        throw new Error(`schema at ${pathKey(path, key)} uses unsupported keyword ${key}`)
      }
    }

    const out: JSONSchema = { ...value }
    if (isSchemaObject(value.properties)) {
      const wasRequired = new Set(Array.isArray(value.required) ? value.required : [])
      const properties: JSONSchema = {}
      for (const [name, property] of Object.entries(value.properties)) {
        if (!isSchemaObject(property)) {
          throw new Error(
            `schema at ${pathKey(pathKey(path, 'properties'), name)} must be an object`,
          )
        }
        const transformed = visit(
          property,
          pathKey(pathKey(path, 'properties'), name),
        ) as JSONSchema
        properties[name] = wasRequired.has(name) ? transformed : nullable(transformed)
      }
      out.properties = properties
    }
    if (value.type === 'object' || (Array.isArray(value.type) && value.type.includes('object'))) {
      const names = isSchemaObject(out.properties) ? Object.keys(out.properties) : []
      out.additionalProperties = false
      out.required = names
    }
    for (const key of ['$defs', 'definitions']) {
      if (!isSchemaObject(value[key])) continue
      out[key] = Object.fromEntries(
        Object.entries(value[key] as JSONSchema).map(([name, schema]) => [
          name,
          visit(schema, pathKey(pathKey(path, key), name)),
        ]),
      )
    }
    if ('items' in value) out.items = visit(value.items, pathKey(path, 'items'))
    if (Array.isArray(value.anyOf)) {
      out.anyOf = value.anyOf.map((schema, i) => visit(schema, `${path}.anyOf[${i}]`))
    }
    return out
  }

  return visit(input, '$') as JSONSchema
}

export function readStrictCodexSchema(path: string): JSONSchema {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`schema at $ is not valid JSON: ${String((e as Error).message ?? e)}`)
  }
  return strictCodexSchema(parsed)
}
