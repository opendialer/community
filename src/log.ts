import { AsyncLocalStorage } from 'node:async_hooks'
import { errorFields } from './error-fields.js'

// Structured logging: one JSON line on stdout (docker logs) and, when AXIOM_TOKEN and AXIOM_DATASET are set,
// the same event batched to Axiom. Logging never throws and never blocks a request.
//
// Rules for callers: log identifiers (ids, statuses, counts, durations, provider names), never secrets,
// message bodies, transcripts, phone numbers, emails, names, addresses, tokens, SQL text or provider response bodies.

type Level = 'debug' | 'info' | 'warn' | 'error'
type Fields = Record<string, unknown>

const service = process.env.LOG_SERVICE ?? 'api'
const environment = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'production'
const dataset = process.env.AXIOM_DATASET?.trim()
const token = process.env.AXIOM_TOKEN?.trim()
const axiomUrl = (process.env.AXIOM_URL?.trim() || 'https://api.axiom.co').replace(/\/+$/, '')
const minLevel = ((process.env.LOG_LEVEL ?? 'info') as Level)
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const context = new AsyncLocalStorage<Fields>()
const queue: string[] = []
const maxQueued = 5000
const batchSize = 200
let timer: NodeJS.Timeout | undefined
let sending = false
let dropped = 0
let lastIngestError = 0
let retryAfter = 0

export const axiomEnabled = Boolean(dataset && token)

// Redact only keys that clearly name a secret or personal data. Ids, counts, statuses and flags such as
// orgId, callerNumberId, tokenCount, authorizationDenied or signatureValid stay readable.
const secretWords = new Set(['password', 'passwd', 'passphrase', 'secret', 'secrets', 'credential', 'credentials', 'cookie', 'cookies', 'bearer', 'jwt'])
const secretHeads = new Set(['token', 'tokens', 'authorization', 'signature', 'apikey'])
const secretTails = new Set(['hash', 'digest', 'value', 'header', 'raw', 'text'])
const piiHeads = new Set(['email', 'emails', 'mail', 'phone', 'msisdn', 'e164', 'transcript', 'body', 'address'])
const piiExact = new Set(['to', 'from', 'name'])
const personNames = new Set(['first', 'last', 'full', 'display', 'contact', 'customer', 'caller', 'callee', 'user'])
const sensitiveNames = new Set(['phonenumber','callernumber','calleenumber','invitecode','invitationcode','verificationcode','resetcode','sessioncode','checkouturl','portalurl','signedurl','callbackurl','databaseurl','connectionstring','headers','audiourl'])
const verdicts = new Map<string, boolean>()

function isSensitive(key: string): boolean {
  const known = verdicts.get(key)
  if (known !== undefined) return known
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const last = words.at(-1) ?? ''
  const headWords = secretTails.has(last) ? words.slice(0, -1) : words
  const head = headWords.at(-1) ?? ''
  const verdict = words.some(w => secretWords.has(w))
    || secretHeads.has(head) || (head === 'key' && ['api', 'auth', 'private', 'secret', 'signing', 'access'].includes(headWords.at(-2) ?? ''))
    || sensitiveNames.has(words.join(''))
    || (words.length === 1 && piiExact.has(last)) || piiHeads.has(last)
    || (last === 'name' && personNames.has(words.at(-2) ?? ''))
  if (verdicts.size < 1000) verdicts.set(key, verdict)
  return verdict
}

function clean(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (value instanceof Error) return errorFields(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value
  if (typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  if (depth >= 3) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 20).map(v => clean(v, depth + 1))
  const out: Fields = {}
  for (const [k, v] of Object.entries(value as Fields)) out[k] = isSensitive(k) ? '[redacted]' : k === 'error' ? errorFields(v) : clean(v, depth + 1)
  return out
}

// Returns false only when an ingest attempt failed, so callers stop retrying in a tight loop.
async function flush(): Promise<boolean> {
  if (!axiomEnabled || sending || !queue.length) return true
  if (Date.now() < retryAfter) return false
  sending = true
  const batch = queue.splice(0, batchSize)
  let ok = true
  try {
    const response = await fetch(`${axiomUrl}/v1/datasets/${encodeURIComponent(dataset!)}/ingest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-ndjson' },
      body: batch.join('\n'),
      signal: AbortSignal.timeout(5000)
    })
    await response.body?.cancel()
    if (!response.ok) throw new Error(`Axiom ingest returned ${response.status}`)
  } catch (error) {
    ok = false
    retryAfter = Date.now() + 2000
    // Put the batch back once; a persistent outage drops the oldest events instead of growing memory.
    queue.unshift(...batch)
    if (queue.length > maxQueued) dropped += queue.splice(0, queue.length - maxQueued).length
    if (Date.now() - lastIngestError > 60_000) {
      lastIngestError = Date.now()
      // Written directly to stderr: routing it through the logger would queue it for the ingest that just failed.
      process.stderr.write(`${JSON.stringify({ _time: new Date().toISOString(), level: 'warn', event: 'axiom_ingest_failed', reason: 'ingest_request_failed', service, environment, ...errorFields(error), queued: queue.length, dropped })}\n`)
    }
  } finally {
    sending = false
  }
  if (ok && dropped) {
    const count = dropped
    dropped = 0
    // Reaches Axiom once ingest works again, so the gap in the timeline is explained.
    logEvent('warn', 'log_events_dropped', { reason: 'axiom_queue_overflow', count })
  }
  if (ok && queue.length >= batchSize) void flush()
  return ok
}

function schedule() {
  if (timer || !axiomEnabled) return
  timer = setInterval(() => { void flush() }, 2000)
  timer.unref()
}

// Where a warn/error was logged: "function file.ts:line" so an alert points straight at the code.
function origin(skip = 0): string | undefined {
  const frames = (new Error().stack ?? '').split('\n').slice(1)
  const frame = frames.filter(l => !/[\\/]log\.[jt]s:/.test(l) && /:\d+:\d+\)?$/.test(l))[skip]
  const match = frame?.match(/at (?:(.+?) \()?(?:file:\/\/)?(.+?)(?:\?[^:]*)?:(\d+):\d+\)?$/)
  if (!match) return undefined
  const file = match[2]!.replace(/^.*?\/(src|dist|sip-gateway)\//, '$1/')
  return `${match[1] ? `${match[1]} ` : ''}${file}:${match[3]}`
}

// For helpers that log on behalf of their caller (forbidden(), invalidCode()): pass `where: callSite()` so the
// warn points at the route code that raised it instead of at the helper.
export function callSite(): string | undefined {
  return origin(1)
}

export function logEvent(level: Level, event: string, fields: Fields = {}): void {
  try {
    if (order[level] < order[minLevel] && level !== 'error') return
    const where = level === 'warn' || level === 'error' ? origin() : undefined
    const current = context.getStore()
    const metadata = { ...current, ...fields }
    if (current?.requestId && metadata.requestId !== current.requestId) {
      if (typeof metadata.requestId === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(metadata.requestId)) {
        metadata.operationRequestId = metadata.requestId
      }
      metadata.requestId = current.requestId
    }
    const record = { ...(where ? { where } : {}), ...(clean(metadata) as Fields), _time: new Date().toISOString(), level, event, service, environment }
    const line = JSON.stringify(record)
    ;(level === 'error' ? process.stderr : process.stdout).write(`${line}\n`)
    if (axiomEnabled) {
      queue.push(line)
      if (queue.length > maxQueued) dropped += queue.splice(0, queue.length - maxQueued).length
      schedule()
      if (queue.length >= batchSize) void flush()
    }
  } catch { /* logging must never break the caller */ }
}

export const log = {
  debug: (event: string, fields?: Fields) => logEvent('debug', event, fields),
  info: (event: string, fields?: Fields) => logEvent('info', event, fields),
  warn: (event: string, fields?: Fields) => logEvent('warn', event, fields),
  // Pass the caught error as `error` to get the sanitised message, SQL state and stack frames.
  error: (event: string, fields?: Fields) => logEvent('error', event, fields)
}

// Add fields (requestId, orgId, userId, jobId…) to every log line written inside `fn`.
export function withLogContext<T>(fields: Fields, fn: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, fn)
}

// Add fields to the current context from deeper code, e.g. once the caller's org is known.
export function addLogContext(fields: Fields): void {
  const store = context.getStore()
  if (store) Object.assign(store, fields)
}

// Time an operation and log its outcome. Rethrows the original error.
export async function timed<T>(event: string, fields: Fields, fn: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try {
    const result = await fn()
    log.info(event, { ...fields, outcome: 'ok', durationMs: Math.round(performance.now() - started) })
    return result
  } catch (error) {
    log.error(event, { ...fields, outcome: 'error', durationMs: Math.round(performance.now() - started), error })
    throw error
  }
}

// Best effort, bounded to five seconds so a dead Axiom cannot hold up shutdown. Never throws.
export async function flushLogs(): Promise<void> {
  try {
    const deadline = Date.now() + 5000
    while ((queue.length || sending) && axiomEnabled && Date.now() < deadline) {
      if (sending) await new Promise(r => setTimeout(r, 50))
      else if (!(await flush())) break
    }
  } catch { /* logging must never break the caller */ }
}

// Call once at startup: says whether log shipping to Axiom is on, so a missing token is visible in the first lines.
export function logAxiomStatus(): void {
  if (axiomEnabled) log.info('axiom_enabled', { dataset })
  else log.warn('axiom_not_configured', { reason: 'missing_env', missing: [...(dataset ? [] : ['AXIOM_DATASET']), ...(token ? [] : ['AXIOM_TOKEN'])] })
}

// A closed pipe (docker restarting, `| head`) must not turn every log line into an uncaught exception.
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})
// Install once from each service entry point. A fatal error is logged safely and exits non-zero.
export function installFatalLogging(): void {
  process.once('uncaughtException', (error, origin) => {
    log.error(origin === 'unhandledRejection' ? 'unhandled_rejection' : 'uncaught_exception', { error })
    void flushLogs().finally(() => process.exit(1))
  })
}
