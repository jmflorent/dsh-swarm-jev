/**
 * Durable append-only journal and fold loader for the objective engine.
 *
 * One JSON event per line; every append is fsynced before the operation
 * acknowledges, and the loader truncates a torn tail (a crash mid-append) back
 * to the last complete line so a restart never guesses at a partial write.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

const parseLine = (line) => {
  if (line.trim() === '') return undefined
  try {
    const event = JSON.parse(line)
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return undefined
    return event
  } catch {
    return undefined
  }
}

/**
 * Read the journal, repairing a torn tail.
 * @param {string} file absolute journal path.
 * @returns {{events: object[], repaired: boolean}} parsed events in order.
 */
export const loadJournal = (file) => {
  if (!existsSync(file)) return { events: [], repaired: false }
  const text = readFileSync(file, 'utf8')
  const events = []
  let offset = 0
  let lastGood = 0
  while (offset < text.length) {
    const newline = text.indexOf('\n', offset)
    if (newline === -1) {
      // No trailing newline: accept the fragment only when it parses whole,
      // otherwise the crash cut it in half and it must be discarded.
      const event = parseLine(text.slice(offset))
      if (event !== undefined) {
        events.push(event)
        lastGood = text.length
      }
      break
    }
    const event = parseLine(text.slice(offset, newline))
    if (event === undefined) break
    events.push(event)
    offset = newline + 1
    lastGood = offset
  }
  let repaired = false
  if (lastGood < text.length) {
    truncateSync(file, lastGood)
    repaired = true
  }
  return { events, repaired }
}

/**
 * Open a synchronous appender; each append is durable before it returns.
 * @param {string} file absolute journal path.
 * @returns {{append: (event: object) => void, close: () => void}}
 */
export const createAppender = (file) => {
  mkdirSync(dirname(file), { recursive: true })
  let fd
  return {
    append(event) {
      const line = `${JSON.stringify(event)}\n`
      if (fd === undefined) fd = openSync(file, 'a')
      writeSync(fd, line)
      fsyncSync(fd)
    },
    close() {
      if (fd !== undefined) {
        closeSync(fd)
        fd = undefined
      }
    },
  }
}
