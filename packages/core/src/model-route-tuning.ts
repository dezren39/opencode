export * as ModelRouteTuning from "./model-route-tuning.js"

import type { ModelRoute } from "./model-route.js"
import type { ErrorBreakdown, TargetStats } from "./model-route-log.js"

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
