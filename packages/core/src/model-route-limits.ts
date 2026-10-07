export * as ModelRouteLimits from "./model-route-limits.js"

/** What a provider said about its rate-limit windows on one response. Header values stay as the
 * provider wrote them (counts, durations such as "6m0s", or timestamps) so the record is exact;
 * `limit`, `remaining` and `reset` are keyed by window ("requests", "tokens", "input-tokens"...). */
export interface Snapshot {
  /** When the response arrived, ms since the epoch. Reset values are relative to this. */
  readonly at: number
  readonly limit?: Readonly<Record<string, string>>
  readonly remaining?: Readonly<Record<string, string>>
  readonly reset?: Readonly<Record<string, string>>
  readonly retryAfterMs?: number
}

export interface Details {
  readonly limit?: Readonly<Record<string, string>> | undefined
  readonly remaining?: Readonly<Record<string, string>> | undefined
  readonly reset?: Readonly<Record<string, string>> | undefined
  readonly retryAfterMs?: number | undefined
}

/** A snapshot of the details, or undefined when the response advertised none. */
export const snapshot = (details: Details | undefined, at: number): Snapshot | undefined => {
  if (!details) return undefined
  const present = (value: Readonly<Record<string, string>> | undefined) =>
    value && Object.keys(value).length > 0 ? value : undefined
  const limit = present(details.limit)
  const remaining = present(details.remaining)
  const reset = present(details.reset)
  if (!limit && !remaining && !reset && details.retryAfterMs === undefined) return undefined
  return {
    at,
    ...(limit ? { limit } : {}),
    ...(remaining ? { remaining } : {}),
    ...(reset ? { reset } : {}),
    ...(details.retryAfterMs !== undefined ? { retryAfterMs: details.retryAfterMs } : {}),
  }
}

const UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/** Milliseconds until a reset, from the forms providers use: a duration ("1s", "6m0s", "250ms",
 * "1h2m3.5s"), plain seconds, or a timestamp. Undefined when the value is none of those. */
export const resetMs = (value: string, at: number): number | undefined => {
  const text = value.trim()
  if (text === "") return undefined
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) * 1_000
  if (/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/.test(text)) {
    let total = 0
    for (const [, amount, unit] of text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) total += Number(amount) * UNITS[unit]
    return total
  }
  const date = Date.parse(text)
  return Number.isNaN(date) ? undefined : Math.max(0, date - at)
}

const MAX_WINDOW_MS = 86_400_000
/** With nothing said about when it resets, an emptied window is assumed to last this long. */
const UNKNOWN_RESET_MS = 60_000
/** A window with this fraction or less of its allowance left counts as spent. */
export const NEAR_FRACTION = 0.05

export interface Window {
  readonly name: string
  readonly remaining: number
  readonly limit: number | undefined
  /** When the window resets, ms since the epoch; undefined when the provider didn't say. */
  readonly resetAt: number | undefined
}

/** The windows a snapshot describes, with numbers parsed. */
export const windows = (value: Snapshot): Window[] =>
  Object.entries(value.remaining ?? {}).flatMap(([name, raw]) => {
    const remaining = Number(raw)
    if (!Number.isFinite(remaining)) return []
    const limit = Number(value.limit?.[name])
    const reset = value.reset?.[name] === undefined ? undefined : resetMs(value.reset[name], value.at)
    return [
      {
        name,
        remaining,
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        resetAt: reset === undefined ? undefined : value.at + reset,
      },
    ]
  })

/**
 * When the provider's own numbers say a target should be left alone until: a window that is empty,
 * or nearly so with a stated reset, holds the target back until it resets. Zero when nothing needs
 * waiting for. An empty window with no stated reset is held for a minute; a nearly empty one with no
 * stated reset is not held, since the next request may well fit.
 */
export const holdUntil = (value: Snapshot, now: number, near = NEAR_FRACTION) => {
  let until = 0
  if (value.retryAfterMs !== undefined) until = Math.max(until, value.at + value.retryAfterMs)
  for (const window of windows(value)) {
    const empty = window.remaining <= 0
    const nearlyEmpty = window.limit !== undefined && window.remaining / window.limit <= near
    if (!empty && !nearlyEmpty) continue
    if (window.resetAt !== undefined) until = Math.max(until, window.resetAt)
    else if (empty) until = Math.max(until, value.at + UNKNOWN_RESET_MS)
  }
  return until > now ? Math.min(until, now + MAX_WINDOW_MS) : 0
}
