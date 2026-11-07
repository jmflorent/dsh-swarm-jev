/**
 * Deterministic persona tool policy.
 *
 * Category selection is a probabilistic, model-consulted narrowing. This module
 * is the other half: an explicit, synchronous rule set inherited from the
 * agent's preset (persona), evaluated on every tool call with no model round-trip
 * and no ambiguity about undeclared tools.
 *
 * A rule may deny a tool outright, allow it outright, constrain the file paths it
 * may touch (`write`/`edit`/`read` carry `file_path`; `glob`/`grep` carry
 * `path`), or deny shell commands by pattern. The policy only ever restricts:
 * anything it does not mention is left untouched, and an `allow` verdict never
 * overrides a denial from another guard.
 */

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Escape one literal glob character for a regular expression. */
const escapeLiteral = (char) => char.replace(/[.+^${}()|[\]\\]/g, '\\$&')

/**
 * Compile a path glob.
 *
 * `**` crosses directory separators (`**​/` also matches zero directories),
 * `*` and `?` never do. Both `/` and `\` in the pattern are treated as `/`.
 */
export const compileGlob = (glob) => {
  if (typeof glob !== 'string' || glob.length === 0) return undefined
  const pattern = glob.replace(/\\/g, '/')
  let source = ''
  let index = 0
  while (index < pattern.length) {
    const char = pattern[index]
    if (char === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:[^/]*/)*'
        index += 3
      } else {
        source += '.*'
        index += 2
      }
      continue
    }
    if (char === '*') {
      source += '[^/]*'
      index += 1
      continue
    }
    if (char === '?') {
      source += '[^/]'
      index += 1
      continue
    }
    source += escapeLiteral(char)
    index += 1
  }
  return new RegExp(`^${source}$`)
}

/** Whether the value matches any of the globs. Invalid globs are skipped. */
export const matchesAny = (globs, value) => {
  for (const glob of globs ?? []) {
    const regex = compileGlob(glob)
    if (regex !== undefined && regex.test(value)) return true
  }
  return false
}

/** The filesystem path a call declares, if any. */
export const extractPath = (exec) => {
  const args = isRecord(exec?.arguments) ? exec.arguments : {}
  for (const key of ['file_path', 'path']) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) return value.replace(/\\/g, '/')
  }
  return undefined
}

/** The command string a bash call declares, if any. */
export const extractCommand = (exec) => {
  const args = isRecord(exec?.arguments) ? exec.arguments : {}
  return typeof args.command === 'string' ? args.command : undefined
}

/**
 * Evaluate a persona policy for one tool call.
 *
 * Returns `{ decision: 'allow' | 'deny', reason? }`. `deny` is a hard verdict:
 * the caller must not execute the call. `allow` means only "the policy has no
 * objection" — it never widens a call another guard denied.
 *
 * Rules, in evaluation order:
 *  1. a tool in `deny` is denied;
 *  2. `default: deny` denies every tool not in `allow` and not given a rule;
 *  3. a rule with `deny: true` is denied;
 *  4. a rule's `commands.deny` patterns are tested against a bash command;
 *  5. a rule's `paths` allow/deny are tested against the declared path; a path
 *     rule with no declared path fails closed, and `paths.deny` wins.
 */
export const evaluatePolicy = (policy, exec) => {
  if (!isRecord(policy)) return { decision: 'allow' }
  const name = typeof exec?.name === 'string' ? exec.name : ''
  if (name === '') return { decision: 'allow' }

  if (Array.isArray(policy.deny) && policy.deny.includes(name)) {
    return { decision: 'deny', reason: `tool "${name}" is denied for this persona` }
  }

  const rule = isRecord(policy.tools) && isRecord(policy.tools[name]) ? policy.tools[name] : undefined
  const allowlisted = Array.isArray(policy.allow) && policy.allow.includes(name)

  if (policy.default === 'deny' && rule === undefined && !allowlisted) {
    return { decision: 'deny', reason: `tool "${name}" is not in this persona's allow-list` }
  }
  if (rule === undefined) return { decision: 'allow' }
  if (rule.deny === true) {
    return { decision: 'deny', reason: `tool "${name}" is denied for this persona` }
  }

  const commandPatterns = isRecord(rule.commands) ? rule.commands.deny : undefined
  if (Array.isArray(commandPatterns) && commandPatterns.length > 0) {
    const command = extractCommand(exec)
    if (command === undefined) {
      return {
        decision: 'deny',
        reason: `tool "${name}" declares no command, so it cannot satisfy this persona's command rules`,
      }
    }
    for (const pattern of commandPatterns) {
      let regex
      try {
        regex = new RegExp(pattern)
      } catch {
        continue
      }
      if (regex.test(command)) {
        return { decision: 'deny', reason: `command matches a pattern denied for this persona` }
      }
    }
  }

  const paths = isRecord(rule.paths) ? rule.paths : undefined
  const pathRules = paths !== undefined && ((paths.allow?.length ?? 0) > 0 || (paths.deny?.length ?? 0) > 0)
  if (pathRules) {
    const path = extractPath(exec)
    if (path === undefined) {
      return {
        decision: 'deny',
        reason: `tool "${name}" declares no file path, so it cannot satisfy this persona's path rules`,
      }
    }
    if (matchesAny(paths.deny, path)) {
      return { decision: 'deny', reason: `path "${path}" is denied for this persona` }
    }
    if ((paths.allow?.length ?? 0) > 0 && !matchesAny(paths.allow, path)) {
      return {
        decision: 'deny',
        reason: `path "${path}" is outside this persona's allowed paths (${paths.allow.join(', ')})`,
      }
    }
  }
  return { decision: 'allow' }
}
