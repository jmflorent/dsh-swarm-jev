/**
 * ObjectiveStore: the durable substrate of the engine.
 *
 *   journal.jsonl   append-only command events, one canonical JSON line each,
 *                   hash-chained, fsynced before the caller is acknowledged
 *   advisory.jsonl  classifier proposals (never part of the command fold)
 *   snapshot.json   periodic full fold + hash, a load-time accelerator only
 *   LOCK            pid + startedAt, single-writer guard
 *   PAUSED          optional operator sentinel: existence forces paused on boot
 *
 * The store knows nothing about objectives: it validates the chain, repairs
 * a torn tail, and refuses to serve a journal with a gap. A write failure
 * makes it degraded (read-only) rather than guessing.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { EVENT_TYPES, SCHEMA, canonicalJson, isRecord, sha256 } from './records.js'

export const GENESIS_HASH = sha256('opm/v1:genesis')

const parseLine = (line) => {
  if (line.trim() === '') return undefined
  try {
    const value = JSON.parse(line)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Hash of one event given the previous chain hash. */
export const eventHash = (previousHash, event) => {
  const { hash: _ignored, ...rest } = event
  return sha256(`${previousHash}${canonicalJson(rest)}`)
}

/**
 * Read a journal file and validate the chain.
 * @returns {{events: object[], repaired: boolean, corrupt?: string, lastHash: string}}
 */
export const readJournal = (file, { fromSeq = 0, fromHash = GENESIS_HASH } = {}) => {
  if (!existsSync(file)) return { events: [], repaired: false, lastHash: fromSeq === 0 ? GENESIS_HASH : fromHash, snapshotMismatch: fromSeq !== 0 }
  const text = readFileSync(file, 'utf8')
  const events = []
  let offset = 0
  let lastGood = 0
  let expectedSeq = 1
  let hash = GENESIS_HASH
  let corrupt
  let snapshotMismatch = fromSeq !== 0
  while (offset < text.length) {
    const newline = text.indexOf('\n', offset)
    const whole = newline !== -1
    const line = text.slice(offset, whole ? newline : text.length)
    const event = parseLine(line)
    if (event === undefined) {
      // A fragment at the very end is a torn append: truncate it. A bad line
      // in the middle of the file is corruption: stop and refuse to guess.
      if (!whole) break
      corrupt = `unparseable line at byte ${offset}`
      break
    }
    if (typeof event.seq !== 'number') {
      corrupt = `event without seq at byte ${offset}`
      break
    }
    if (event.seq !== expectedSeq) {
      corrupt = `sequence gap: expected ${expectedSeq}, found ${event.seq}`
      break
    }
    if (event.schema !== SCHEMA || !EVENT_TYPES.has(event.type)) {
      corrupt = `unknown schema/type at seq ${event.seq}`
      break
    }
    // The whole chain is validated from genesis on every load; a snapshot only
    // decides which events still have to be folded.
    if (typeof event.hash !== 'string' || eventHash(hash, event) !== event.hash) {
      corrupt = `hash mismatch at seq ${event.seq}`
      break
    }
    hash = event.hash
    if (event.seq === fromSeq) snapshotMismatch = hash !== fromHash
    if (event.seq > fromSeq) events.push(event)
    expectedSeq += 1
    offset = whole ? newline + 1 : text.length
    lastGood = offset
  }
  let repaired = false
  if (corrupt === undefined && lastGood < text.length) {
    truncateSync(file, lastGood)
    repaired = true
  }
  if (corrupt === undefined && fromSeq > expectedSeq - 1) snapshotMismatch = true
  return { events, repaired, ...(corrupt === undefined ? {} : { corrupt }), lastHash: hash, snapshotMismatch }
}

const readLock = (file) => {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return isRecord(value) && typeof value.pid === 'number' ? value : undefined
  } catch {
    return undefined
  }
}
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Open the store. Never throws for a corrupt or locked directory: the result
 * reports `corrupt` / `locked`, and the engine starts degraded.
 */
export const openStore = ({ dataDir, snapshotEvery = 128, now = Date.now, pid = process.pid }) => {
  mkdirSync(dataDir, { recursive: true })
  const journalFile = join(dataDir, 'journal.jsonl')
  const advisoryFile = join(dataDir, 'advisory.jsonl')
  const snapshotFile = join(dataDir, 'snapshot.json')
  const lockFile = join(dataDir, 'LOCK')
  const pausedFile = join(dataDir, 'PAUSED')

  // --- single-writer lock -------------------------------------------------
  let locked
  const existing = readLock(lockFile)
  if (existing !== undefined && existing.pid !== pid && pidAlive(existing.pid)) {
    locked = `journal is locked by pid ${existing.pid} since ${existing.startedAt}`
  } else {
    writeFileSync(lockFile, `${JSON.stringify({ pid, startedAt: new Date(now()).toISOString() })}\n`)
  }

  // --- snapshot + journal ----------------------------------------------------
  let snapshot
  if (existsSync(snapshotFile)) {
    try {
      const parsed = JSON.parse(readFileSync(snapshotFile, 'utf8'))
      if (isRecord(parsed) && typeof parsed.lastSeq === 'number' && typeof parsed.hash === 'string' && isRecord(parsed.state)) {
        const stateSeq = parsed.state.lastSeq
        if (stateSeq === parsed.lastSeq && sha256(canonicalJson(parsed.state)) === parsed.stateHash) snapshot = parsed
      }
    } catch {
      snapshot = undefined
    }
  }
  const loaded = readJournal(journalFile, snapshot === undefined ? {} : { fromSeq: snapshot.lastSeq, fromHash: snapshot.hash })
  let corrupt = loaded.corrupt
  let snapshotUsed = snapshot !== undefined
  if ((corrupt !== undefined || loaded.snapshotMismatch) && snapshot !== undefined) {
    // A snapshot that no longer matches the journal is derived data: fall back
    // to a complete replay before declaring the registry corrupt.
    const full = readJournal(journalFile)
    if (full.corrupt === undefined) {
      snapshot = undefined
      snapshotUsed = false
      corrupt = undefined
      loaded.events = full.events
      loaded.lastHash = full.lastHash
      loaded.repaired = full.repaired
    }
  }

  let fd
  let degraded = locked !== undefined || corrupt !== undefined ? (locked ?? corrupt) : undefined
  let lastSeq = loaded.events.length > 0 ? loaded.events[loaded.events.length - 1].seq : (snapshot?.lastSeq ?? 0)
  let lastHash = loaded.lastHash
  let sinceSnapshot = loaded.events.length

  const appendLine = (file, line) => {
    if (file === journalFile) {
      if (fd === undefined) fd = openSync(journalFile, 'a')
      writeSync(fd, line)
      fsyncSync(fd)
      return
    }
    const other = openSync(file, 'a')
    try {
      writeSync(other, line)
      fsyncSync(other)
    } finally {
      closeSync(other)
    }
  }

  const store = {
    dataDir,
    journalFile,
    advisoryFile,
    snapshotFile,
    get degraded() {
      return degraded
    },
    get locked() {
      return locked !== undefined
    },
    get lastSeq() {
      return lastSeq
    },
    get lastHash() {
      return lastHash
    },
    repaired: loaded.repaired,
    snapshotUsed,
    snapshot,
    events: loaded.events,
    pausedSentinel: () => existsSync(pausedFile),
    /** Append one command event. Throws `persistence-failed` and degrades on I/O failure. */
    append(partial) {
      if (degraded !== undefined) {
        const error = new Error(`engine is degraded: ${degraded}`)
        error.code = 'engine-degraded'
        throw error
      }
      const event = { seq: lastSeq + 1, schema: SCHEMA, ...partial }
      event.hash = eventHash(lastHash, event)
      try {
        appendLine(journalFile, `${canonicalJson(event)}\n`)
      } catch (error) {
        degraded = `journal append failed: ${error?.message ?? error}`
        const failure = new Error(degraded)
        failure.code = 'persistence-failed'
        throw failure
      }
      lastSeq = event.seq
      lastHash = event.hash
      sinceSnapshot += 1
      return event
    },
    /** Append an advisory (proposal) record. Failures never degrade the command plane. */
    appendAdvisory(record) {
      try {
        appendLine(advisoryFile, `${canonicalJson({ schema: SCHEMA, at: new Date(now()).toISOString(), ...record })}\n`)
        return true
      } catch {
        return false
      }
    },
    readAdvisory(limit = 20) {
      if (!existsSync(advisoryFile)) return []
      const lines = readFileSync(advisoryFile, 'utf8').split('\n').filter((line) => line.trim() !== '')
      return lines.slice(-limit).map(parseLine).filter((value) => value !== undefined)
    },
    /** Whether a snapshot is due. */
    snapshotDue: () => sinceSnapshot >= snapshotEvery,
    /** Write the snapshot atomically (temp + fsync + rename). */
    writeSnapshot(state) {
      // A snapshot whose folded lastSeq differs from the store's lastSeq would
      // replay only part of the journal on the next load; skip it instead.
      if (typeof state?.lastSeq === 'number' && state.lastSeq !== lastSeq) return false
      const payload = { schema: SCHEMA, lastSeq, hash: lastHash, writtenAt: new Date(now()).toISOString(), stateHash: sha256(canonicalJson(state)), state }
      const temp = `${snapshotFile}.tmp`
      try {
        const handle = openSync(temp, 'w')
        try {
          writeSync(handle, JSON.stringify(payload))
          fsyncSync(handle)
        } finally {
          closeSync(handle)
        }
        renameSync(temp, snapshotFile)
        sinceSnapshot = 0
        return true
      } catch {
        try {
          rmSync(temp, { force: true })
        } catch {
          /* best effort */
        }
        return false
      }
    },
    journalBytes() {
      try {
        return statSync(journalFile).size
      } catch {
        return 0
      }
    },
    close() {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* already closed */
        }
        fd = undefined
      }
      if (locked === undefined) {
        const current = readLock(lockFile)
        if (current?.pid === pid) {
          try {
            unlinkSync(lockFile)
          } catch {
            /* lock already gone */
          }
        }
      }
    },
  }
  return store
}
