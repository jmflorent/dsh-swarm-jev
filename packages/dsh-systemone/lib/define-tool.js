/**
 * Local tool-definition helper for the self-contained systemone bundle.
 *
 * The harness `tools` service expects the exact shape `@deepseek-ai/dsh-tools`
 * `defineTool` produces: `{ name, description, parameters (JSON Schema),
 * output: { schema, render }, execute, isConcurrencySafe? }`. Importing that
 * package would drag a large runtime dependency closure into a linked install,
 * so this file provides the same contract for the five systemone tools.
 *
 * Parameter validation is intentionally minimal — required fields and scalar
 * types — because every handler performs its own domain validation (question
 * shape, image bounds, request limits). The definition's output schema is left
 * unconstrained; all five tools render compact JSON explicitly.
 */

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

const toJsonSchema = (spec) => {
  if (!isRecord(spec)) return {}
  const description = typeof spec.description === 'string' ? spec.description : undefined
  const type = spec.type
  if (type === 'json') return description === undefined ? {} : { description }
  const schema = {}
  if (typeof type === 'string') schema.type = type
  if (description !== undefined) schema.description = description
  if (type === 'object' && spec.additionalProperties !== undefined) {
    schema.additionalProperties = spec.additionalProperties
  }
  if (spec.items !== undefined) schema.items = toJsonSchema(spec.items)
  if (isRecord(spec.properties)) {
    schema.properties = {}
    const required = []
    for (const [key, child] of Object.entries(spec.properties)) {
      schema.properties[key] = toJsonSchema(child)
      if (isRecord(child) && child.required === true) required.push(key)
    }
    if (required.length > 0) schema.required = required
  }
  if (Array.isArray(spec.oneOf)) schema.oneOf = spec.oneOf.map(toJsonSchema)
  return schema
}

const toParameters = (parameters) => {
  const properties = {}
  const required = []
  for (const [name, spec] of Object.entries(parameters ?? {})) {
    properties[name] = toJsonSchema(spec)
    if (isRecord(spec) && spec.required === true) required.push(name)
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

const EXPECTED = {
  string: 'a string',
  number: 'a number',
  integer: 'an integer',
  boolean: 'a boolean',
  array: 'an array',
  object: 'an object',
}

const typeMatches = (type, value) => {
  switch (type) {
    case undefined:
    case 'json':
      return true
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isRecord(value)
    default:
      return true
  }
}

const validate = (parameters, args) => {
  const input = isRecord(args) ? args : {}
  for (const [name, spec] of Object.entries(parameters ?? {})) {
    if (!isRecord(spec)) continue
    const value = input[name]
    if (value === undefined) {
      if (spec.required === true) throw new Error(`missing required argument "${name}"`)
      continue
    }
    if (!typeMatches(spec.type, value)) {
      throw new Error(`argument "${name}" must be ${EXPECTED[spec.type] ?? 'valid'} (got ${Array.isArray(value) ? 'array' : typeof value})`)
    }
  }
  return input
}

/**
 * Build a registry-ready tool definition from the same options object the
 * vendored `defineTool` accepted.
 * @param {object} options tool declaration.
 * @returns registry-ready definition.
 */
export const defineTool = (options) => ({
  name: options.name,
  description: options.description,
  parameters: toParameters(options.parameters),
  output: {
    schema: {},
    render: (args, value) => options.output.render(args, value),
  },
  ...(typeof options.isConcurrencySafe === 'function'
    ? { isConcurrencySafe: () => options.isConcurrencySafe() }
    : {}),
  async execute(args, exec) {
    const value = await options.execute(validate(options.parameters, args), exec)
    // Tool outputs must be lossless JSON; undefined-valued keys are dropped by
    // the serialization round-trip, matching the previous defineTool wrapper.
    return JSON.parse(JSON.stringify(value ?? {}))
  },
})
