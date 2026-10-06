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
