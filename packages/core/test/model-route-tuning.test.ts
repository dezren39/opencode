import { describe, expect, test } from "bun:test"
import type { ErrorBreakdown, TargetStats } from "@opencode/core/model-route-log"
import { ModelRouteTuning } from "@opencode/core/model-route-tuning"

const stats = (modelID: string, over: Partial<TargetStats> = {}): TargetStats => ({
  providerID: "p",
  modelID,
  attempts: 20,
  failures: 0,
  timeouts: 0,
  avgFirstTokenMs: 500,
  avgResponseMs: 4_000,
  avgTokensPerSecond: 50,
  ...over,
})

const quota = (modelID: string): ErrorBreakdown => ({
  providerID: "p",
  modelID,
  tag: "QuotaExceeded",
  code: null,
  status: 429,
  count: 3,
  lastTime: 1,
  lastMessage: "out of quota",
})

describe("ModelRouteTuning.suggest", () => {
  const now = 1_000_000

  test("leaves healthy and thinly sampled targets alone", () => {
    expect(
      ModelRouteTuning.suggest({
        stats: [stats("ok"), stats("new", { attempts: 2, failures: 2 })],
        errors: [],
        now,
      }),
    ).toEqual([])
  })

  test("lowers the share of a failing target in proportion to how badly it fails", () => {
    const result = ModelRouteTuning.suggest({
      stats: [stats("bad", { failures: 12 }), stats("shaky", { failures: 5 }), stats("ok")],
      errors: [],
      now,
    })
    expect(result.map((item) => [item.match, item.action, item.factor])).toEqual([
      ["p/bad", "weight", 0.1],
      ["p/shaky", "weight", 0.5],
    ])
    expect(result[0].id).toBe("auto:p/bad")
    expect(result[0].until).toBe(now + 30 * 60_000)
  })

  test("skips a target that reported an exhausted quota, even with little data", () => {
    const result = ModelRouteTuning.suggest({
      stats: [stats("dry", { attempts: 3, failures: 3 })],
      errors: [quota("dry")],
      now,
    })
    expect(result).toMatchObject([{ match: "p/dry", action: "skip" }])
  })

  test("downweights a target far slower to first output than its peers", () => {
    const result = ModelRouteTuning.suggest({
      stats: [stats("a"), stats("b"), stats("slow", { avgFirstTokenMs: 4_000 })],
      errors: [],
      now,
    })
    expect(result.map((item) => item.match)).toEqual(["p/slow"])
  })
})

describe("ModelRouteTuning predictions", () => {
  const hourly = [
    { providerID: "p", modelID: "m", hour: 3, attempts: 20, failures: 1 },
    { providerID: "p", modelID: "m", hour: 14, attempts: 20, failures: 12 },
    { providerID: "q", modelID: "n", hour: 3, attempts: 20, failures: 1 },
    { providerID: "q", modelID: "n", hour: 14, attempts: 20, failures: 1 },
  ]

  test("flags a target that has been unreliable at this hour, not one that has not", () => {
    const at = Date.UTC(2026, 0, 1, 14, 0, 0)
    const predictions = ModelRouteTuning.predict({ hourly, errors: [], now: at })
    expect(predictions).toEqual([
      {
        target: "p/m",
        state: "busy-hour",
        detail: "60% of 20 attempts failed at hour 14, against 5% at other hours",
      },
    ])
  })

  test("says nothing without enough attempts in the hour", () => {
    const sparse = [{ providerID: "p", modelID: "m", hour: 14, attempts: 2, failures: 2 }]
    expect(ModelRouteTuning.predict({ hourly: sparse, errors: [], now: Date.UTC(2026, 0, 1, 14) })).toEqual([])
  })

  test("reads a quota reset out of the provider's own message", () => {
    const at = Date.UTC(2026, 0, 1, 14)
    const errors = [
      {
        providerID: "q",
        modelID: "n",
        tag: "QuotaExceeded",
        code: null,
        status: 429,
        count: 3,
        lastTime: at,
        lastMessage: "quota exceeded; try again in 3 hours",
      },
    ]
    expect(ModelRouteTuning.predict({ hourly, errors, now: at })).toContainEqual({
      target: "q/n",
      state: "quota-reset",
      detail: `provider message says the quota returns ${new Date(at + 3 * 3_600_000).toISOString()}`,
      until: at + 3 * 3_600_000,
    })
  })
})

describe("ModelRouteTuning.parseQuotaReset", () => {
  const at = Date.UTC(2026, 0, 1, 14)

  test("reads absolute and relative reset times", () => {
    expect(ModelRouteTuning.parseQuotaReset("quota exhausted; resets at 2026-01-01T18:00:00Z", at)).toBe(
      Date.UTC(2026, 0, 1, 18),
    )
    expect(ModelRouteTuning.parseQuotaReset("rate limit reached, back in 30 minutes", at)).toBe(at + 1_800_000)
    expect(ModelRouteTuning.parseQuotaReset("try in 5 minutes", at)).toBeUndefined()
    expect(ModelRouteTuning.parseQuotaReset(undefined, at)).toBeUndefined()
  })
})

describe("ModelRouteTuning notes", () => {
  const at = Date.UTC(2026, 0, 1, 14)

  test("reads the match and text of each note line", () => {
    expect(
      ModelRouteTuning.parseNotes([
        "anthropic/claude-opus-5: promo credits reset at 2026-01-04T00:00:00Z",
        "no separator here",
        ": no match",
        "openai/gpt-6-luna:   ",
      ]),
    ).toEqual([{ match: "anthropic/claude-opus-5", text: "promo credits reset at 2026-01-04T00:00:00Z" }])
    expect(ModelRouteTuning.parseNotes(undefined)).toEqual([])
  })

  test("a note that states when the quota returns skips the target until then", () => {
    const adjustments = ModelRouteTuning.noteAdjustments(
      [{ match: "claude", text: "promo credits reset at 2026-01-04T00:00:00Z" }],
      at,
      30 * 60_000,
    )
    expect(adjustments).toEqual([
      {
        id: "note:claude",
        match: "claude",
        action: "skip",
        until: Date.parse("2026-01-04T00:00:00Z"),
        note: "promo credits reset at 2026-01-04T00:00:00Z",
      },
    ])
  })

  test("a note that says nothing actionable is left to the agent to read", () => {
    expect(
      ModelRouteTuning.noteAdjustments([{ match: "claude", text: "favored while the promo lasts" }], at, 60_000),
    ).toEqual([])
    expect(ModelRouteTuning.noteAdjustments([{ match: "claude", text: "" }], at, 60_000)).toEqual([])
  })
})
