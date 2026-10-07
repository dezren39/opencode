export * as ModelRouteTuning from "./model-route-tuning.js"

import { Duration, Effect, Option } from "effect"
import { ModelRoute } from "./model-route.js"
import { ModelRouteLog, type ErrorBreakdown, type HourlyStat, type TargetStats } from "./model-route-log.js"
import { ModelRouteLimits } from "./model-route-limits.js"
import { ModelRouteAutonomy } from "./model-route-autonomy.js"

/** Adjustments the routing history argues for. Deterministic and conservative: they only ever
 * lower a target's share or skip it, they expire on their own, and each is replaced (same id) by
 * the next run instead of piling up. Anything cleverer is left to the agent reading the same data. */
export interface Input {
  readonly stats: readonly TargetStats[]
  readonly errors: readonly ErrorBreakdown[]
  readonly now: number
  /** Minimum attempts before a target's record is judged. */
  readonly minAttempts?: number
  /** How long a suggested adjustment lasts. */
  readonly holdMs?: number
}

const median = (values: readonly number[]) => {
  const sorted = values.toSorted((left, right) => left - right)
  return sorted.length === 0 ? undefined : sorted[Math.floor(sorted.length / 2)]
}

const targetKey = (providerID: string, modelID: string) => `${providerID}/${modelID}`

export const suggest = (input: Input): ModelRoute.Adjustment[] => {
  const minAttempts = input.minAttempts ?? 5
  const holdMs = input.holdMs ?? 30 * 60_000
  const until = input.now + holdMs
  const result: ModelRoute.Adjustment[] = []
  const typicalFirstToken = median(
    input.stats.flatMap((row) => (row.avgFirstTokenMs === null ? [] : [row.avgFirstTokenMs])),
  )

  for (const row of input.stats) {
    const key = targetKey(row.providerID, row.modelID)
    const base = { id: `auto:${key}`, match: key, until }
    const quotaFailures = input.errors
      .filter(
        (error) =>
          error.providerID === row.providerID && error.modelID === row.modelID && error.tag === "QuotaExceeded",
      )
      .reduce((sum, error) => sum + error.count, 0)
    if (quotaFailures > 0) {
      result.push({ ...base, action: "skip", note: `${quotaFailures} quota-exceeded failures in the window` })
      continue
    }
    if (row.attempts < minAttempts) continue
    const failureRate = row.failures / row.attempts
    if (failureRate >= 0.5) {
      result.push({
        ...base,
        action: "weight",
        factor: 0.1,
        note: `${Math.round(failureRate * 100)}% of ${row.attempts} attempts failed`,
      })
    } else if (failureRate >= 0.2) {
      result.push({
        ...base,
        action: "weight",
        factor: 0.5,
        note: `${Math.round(failureRate * 100)}% of ${row.attempts} attempts failed`,
      })
    } else if (
      typicalFirstToken !== undefined &&
      input.stats.length >= 3 &&
      row.avgFirstTokenMs !== null &&
      row.avgFirstTokenMs > typicalFirstToken * 2.5
    ) {
      result.push({
        ...base,
        action: "weight",
        factor: 0.5,
        note: `first output ${Math.round(row.avgFirstTokenMs)}ms against a typical ${Math.round(typicalFirstToken)}ms`,
      })
    }
  }
  return result
}

export interface Prediction {
  readonly target: string
  /** `busy-hour` means this target has been unreliable at this hour; `quota-reset` comes from the
   * provider's own error message; `steady` when there is no reason to think otherwise. */
  readonly state: "steady" | "busy-hour" | "quota-reset"
  readonly detail: string
  /** For `quota-reset`, when the provider said the quota comes back. */
  readonly until?: number
}

/** Reads the pattern of when each target tends to fail: a target that only fails at certain hours
 * is different from one that fails all the time. Off by default, and only confident with enough
 * attempts in the hour. */
export const predict = (input: {
  readonly hourly: readonly HourlyStat[]
  readonly errors: readonly ErrorBreakdown[]
  readonly now: number
  readonly minHourlyAttempts?: number
  readonly hourRatio?: number
  readonly minHourlySamples?: number
}): Prediction[] => {
  const minAttempts = input.minHourlyAttempts ?? 5
  const ratio = input.hourRatio ?? 2
  const minSamples = input.minHourlySamples ?? 3
  const hour = new Date(input.now).getUTCHours()
  const result: Prediction[] = []
  const byTarget = new Map<string, HourlyStat[]>()
  for (const row of input.hourly) {
    const key = `${row.providerID}/${row.modelID}`
    byTarget.set(key, [...(byTarget.get(key) ?? []), row])
  }
  for (const [target, rows] of byTarget) {
    // The baseline is this target at every other hour: including the hour being judged would
    // inflate it and hide exactly the spike being looked for.
    const other = rows.filter((row) => row.hour !== hour)
    const baselineTotal = other.reduce((sum, row) => sum + row.attempts, 0)
    const baseline = baselineTotal === 0 ? 0 : other.reduce((sum, row) => sum + row.failures, 0) / baselineTotal
    const atHour = rows.filter((row) => row.hour === hour)
    const attempts = atHour.reduce((sum, row) => sum + row.attempts, 0)
    const failures = atHour.reduce((sum, row) => sum + row.failures, 0)
    const rate = failures / attempts
    // Enough attempts in this hour, and enough history elsewhere, to say anything.
    if (attempts < minAttempts || baselineTotal < minSamples) continue
    if (rate > Math.max(0.05, baseline * ratio))
      result.push({
        target,
        state: "busy-hour",
        detail: `${Math.round(rate * 100)}% of ${attempts} attempts failed at hour ${hour}, against ${Math.round(baseline * 100)}% at other hours`,
      })
  }
  for (const error of input.errors) {
    const target = `${error.providerID}/${error.modelID}`
    const reset = ModelRouteLimits.resetAtFromMessage(error.lastMessage ?? undefined, input.now)
    if (!reset) continue
    const prior = result.find((entry) => entry.target === target)
    if (prior) continue
    result.push({
      target,
      state: "quota-reset",
      detail: `provider message says the quota returns ${new Date(reset).toISOString()}`,
      until: reset,
    })
  }
  return result
}

/**
 * When a provider says a quota comes back, from the text of its error. Two forms are read: an
 * absolute time ("resets at 2026-01-01T00:00:00Z", "back at 2026-01-01") and a relative one
 * ("in 3 hours", "in 30 minutes", "in 45s"). Nothing else is guessed at.
 */
export const parseQuotaReset = (message: string | undefined, now: number): number | undefined => {
  if (!message) return undefined
  const text = message.toLowerCase()
  if (!/(?:quota|limit|rate limit)/.test(text)) return undefined
  const absolute =
    /(?:reset|resume|back|available|return)[a-z ]{0,20}(?:at|on)?\s*(\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?)?)/.exec(
      text,
    )?.[1]
  if (absolute) {
    const date = Date.parse(absolute)
    if (!Number.isNaN(date)) return date
  }
  const relative = /in\s+(\d+)\s*(second|minute|hour|day)s?/.exec(text)
  if (relative) {
    const unit = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000 } as Record<string, number>
    return now + Number(relative[1]) * (unit[relative[2]] ?? 1_000)
  }
  return undefined
}

export interface Settings {
  readonly enabled?: boolean
  readonly intervalMinutes?: number
  readonly windowHours?: number
  /**
   * What the user knows that the history cannot say: provider documentation, a stated quota reset,
   * a plan to keep. One note per line, `match: text`, where `match` is a case-insensitive substring
   * of provider/model and the text may state when to come back ("skip until 2026-01-01T06:00:00Z",
   * "reset at 2026-01-01", "back in 3 hours").
   */
  readonly notes?: readonly string[]
}

export interface Note {
  readonly match: string
  readonly text: string
}

/** Parses the `match: text` lines from the settings notes. */
export const parseNotes = (notes: readonly string[] | undefined): Note[] =>
  (notes ?? []).flatMap((line) => {
    const separator = line.indexOf(":")
    if (separator <= 0) return []
    const match = line.slice(0, separator).trim()
    const text = line.slice(separator + 1).trim()
    return match && text ? [{ match, text }] : []
  })

/** The adjustments the notes argue for: a stated reset time skips the target until it arrives. */
export const noteAdjustments = (notes: readonly Note[], now: number, holdMs: number): ModelRoute.Adjustment[] =>
  notes.flatMap((note) => {
    const until = ModelRouteLimits.resetAtFromMessage(note.text, now)
    if (until === undefined) return []
    return [
      {
        id: `note:${note.match}`,
        match: note.match,
        action: "skip" as const,
        // A user-stated reset can be days out; only a runaway value is bounded.
        until: Math.min(until, now + 30 * 86_400_000),
        note: note.text,
      },
    ]
  })

export const DEFAULT_INTERVAL_MINUTES = 15
export const DEFAULT_WINDOW_HOURS = 24

/** One review: reads the recent history and puts the resulting adjustments in force. Returns them. */
export const review = (options: {
  readonly windowHours: number
  readonly holdMs: number
  readonly notes?: readonly string[]
  /** Skip time-of-day and error-text prediction. Defaults to false. */
  readonly withoutPredictions?: boolean
}) =>
  Effect.gen(function* () {
    const now = Date.now()
    const since = now - options.windowHours * 3_600_000
    const read = yield* ModelRouteLog.withDb((db) =>
      Effect.all({
        stats: ModelRouteLog.targetStats(db, since),
        errors: ModelRouteLog.errorBreakdown(db, since),
      }).pipe(Effect.orDie),
    )
    const readHourly = yield* ModelRouteLog.withDb((db) => ModelRouteLog.hourlyStats(db, since).pipe(Effect.orDie))
    const { stats, errors } = Option.getOrElse(read, () => ({ stats: [], errors: [] }))
    const hourly = Option.getOrElse(readHourly, () => [] as ModelRouteLog.HourlyStat[])
    const predictions = options.withoutPredictions ? [] : predict({ hourly, errors, now })
    const suggestions = suggest({ stats, errors, now, holdMs: options.holdMs })
    suggestions.push(...noteAdjustments(parseNotes(options.notes), now, options.holdMs))
    // A target that has been unreliable at this hour is down-weighted for a while, and one whose
    // message says when its quota returns is skipped until then.
    for (const prediction of predictions) {
      if (prediction.state === "busy-hour")
        suggestions.push({
          id: `auto-hourly:${prediction.target}`,
          match: prediction.target,
          action: "weight",
          factor: 0.5,
          until: now + options.holdMs,
          note: prediction.detail,
        })
      else if (prediction.until !== undefined)
        suggestions.push({
          id: `auto-quota:${prediction.target}`,
          match: prediction.target,
          action: "skip",
          until: prediction.until,
          note: prediction.detail,
        })
    }
    for (const item of suggestions) ModelRoute.addAdjustment(item, item.note)
    return suggestions
  })

/** Reviews on a schedule for as long as the scope lives. The settings are read again before every
 * cycle, so enabling, disabling or retiming takes effect without a restart. */
export const schedule = (
  read: () => Settings | undefined,
  levels: () => readonly (ModelRouteAutonomy.Level | undefined)[] = () => [],
) =>
  Effect.gen(function* () {
    while (true) {
      const interval = Math.max(1, read()?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES)
      yield* Effect.sleep(Duration.minutes(interval))
      const settings = read()
      if (!ModelRouteAutonomy.reviews(levels(), settings?.enabled === true)) continue
      const applied = yield* review({
        notes: settings?.notes,
        withoutPredictions: !ModelRouteAutonomy.predicts(levels()),
        windowHours: settings?.windowHours ?? DEFAULT_WINDOW_HOURS,
        // Long enough to bridge to the next review, so an adjustment does not flicker off in between.
        holdMs: Math.max(1, settings?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES) * 2 * 60_000,
      }).pipe(Effect.catchCause(() => Effect.succeed([] as ModelRoute.Adjustment[])))
      if (applied.length > 0)
        yield* Effect.logInfo("model route tuning applied adjustments", {
          adjustments: applied.map((item) => `${item.action} ${item.match}`),
        })
    }
  })
