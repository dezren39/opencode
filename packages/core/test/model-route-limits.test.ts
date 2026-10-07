import { describe, expect, test } from "bun:test"
import { ModelRouteLimits } from "@opencode/core/model-route-limits"

const at = 1_000_000

describe("ModelRouteLimits.resetMs", () => {
  test("reads durations in the forms providers write them", () => {
    expect(ModelRouteLimits.resetMs("1s", at)).toBe(1_000)
    expect(ModelRouteLimits.resetMs("250ms", at)).toBe(250)
    expect(ModelRouteLimits.resetMs("6m0s", at)).toBe(360_000)
    expect(ModelRouteLimits.resetMs("1h2m3.5s", at)).toBe(3_723_500)
    expect(ModelRouteLimits.resetMs("1d", at)).toBe(86_400_000)
  })

  test("reads plain seconds and timestamps relative to the response time", () => {
    expect(ModelRouteLimits.resetMs("30", at)).toBe(30_000)
    expect(ModelRouteLimits.resetMs("0.5", at)).toBe(500)
    expect(ModelRouteLimits.resetMs(new Date(at + 90_000).toISOString(), at)).toBe(90_000)
    expect(ModelRouteLimits.resetMs(new Date(at - 5_000).toISOString(), at)).toBe(0)
  })

  test("returns undefined for anything else", () => {
    expect(ModelRouteLimits.resetMs("", at)).toBeUndefined()
    expect(ModelRouteLimits.resetMs("soon", at)).toBeUndefined()
    expect(ModelRouteLimits.resetMs("5 minutes", at)).toBeUndefined()
  })
})

describe("ModelRouteLimits.snapshot", () => {
  test("is undefined when the response advertised nothing", () => {
    expect(ModelRouteLimits.snapshot(undefined, at)).toBeUndefined()
    expect(ModelRouteLimits.snapshot({ limit: {}, remaining: {}, reset: {} }, at)).toBeUndefined()
  })

  test("keeps only what was advertised", () => {
    expect(ModelRouteLimits.snapshot({ remaining: { requests: "9" }, retryAfterMs: 500 }, at)).toEqual({
      at,
      remaining: { requests: "9" },
      retryAfterMs: 500,
    })
  })
})

describe("ModelRouteLimits.holdUntil", () => {
  const snap = (value: Omit<ModelRouteLimits.Snapshot, "at">): ModelRouteLimits.Snapshot => ({ at, ...value })

  test("holds an emptied window until it resets", () => {
    const until = ModelRouteLimits.holdUntil(
      snap({ limit: { requests: "60" }, remaining: { requests: "0" }, reset: { requests: "20s" } }),
      at,
    )
    expect(until).toBe(at + 20_000)
  })

  test("holds a nearly spent window with a stated reset, but not a healthy one", () => {
    const nearly = snap({ limit: { tokens: "1000" }, remaining: { tokens: "40" }, reset: { tokens: "6m0s" } })
    expect(ModelRouteLimits.holdUntil(nearly, at)).toBe(at + 360_000)
    const healthy = snap({ limit: { tokens: "1000" }, remaining: { tokens: "400" }, reset: { tokens: "6m0s" } })
    expect(ModelRouteLimits.holdUntil(healthy, at)).toBe(0)
  })

  test("without a stated reset only an empty window is held, and only for a minute", () => {
    expect(ModelRouteLimits.holdUntil(snap({ remaining: { requests: "0" } }), at)).toBe(at + 60_000)
    expect(ModelRouteLimits.holdUntil(snap({ limit: { requests: "100" }, remaining: { requests: "3" } }), at)).toBe(0)
  })

  test("takes the latest of several windows and honours retry-after", () => {
    const value = snap({
      limit: { requests: "60", "input-tokens": "1000" },
      remaining: { requests: "0", "input-tokens": "0" },
      reset: { requests: "10s", "input-tokens": "45s" },
      retryAfterMs: 5_000,
    })
    expect(ModelRouteLimits.holdUntil(value, at)).toBe(at + 45_000)
    expect(ModelRouteLimits.holdUntil(snap({ retryAfterMs: 8_000 }), at)).toBe(at + 8_000)
  })

  test("ignores windows already over and caps what a day is", () => {
    const old = snap({ remaining: { requests: "0" }, reset: { requests: "10s" } })
    expect(ModelRouteLimits.holdUntil(old, at + 30_000)).toBe(0)
    const huge = snap({ remaining: { requests: "0" }, reset: { requests: "30d" } })
    expect(ModelRouteLimits.holdUntil(huge, at)).toBe(at + 86_400_000)
  })

  test("skips values that are not numbers", () => {
    expect(ModelRouteLimits.holdUntil(snap({ remaining: { requests: "lots" }, reset: { requests: "1s" } }), at)).toBe(0)
  })
})

describe("ModelRouteLimits.retryHintFromMessage", () => {
  const at = 1_000_000

  test("reads waits stated in the error text", () => {
    expect(ModelRouteLimits.retryHintFromMessage("retry after 2026-01-01T00:00:00Z", at)).toBe(
      Date.parse("2026-01-01T00:00:00Z") - at,
    )
    expect(ModelRouteLimits.retryHintFromMessage("try again in 45 seconds", at)).toBe(45_000)
    expect(ModelRouteLimits.retryHintFromMessage("wait in 2 hours", at)).toBe(7_200_000)
  })

  test("does not guess at anything else", () => {
    expect(ModelRouteLimits.retryHintFromMessage("server exploded", at)).toBeUndefined()
    expect(ModelRouteLimits.retryHintFromMessage(undefined, at)).toBeUndefined()
  })
})
