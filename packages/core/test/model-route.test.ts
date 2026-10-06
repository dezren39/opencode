import { afterEach, describe, expect, test } from "bun:test"
import { ModelRoute } from "@opencode/core/model-route"

const target = ModelRoute.ref({ providerID: "openai", model: "gpt-6-luna" })

afterEach(() => {
  ModelRoute.resetHealth()
  ModelRoute.resetSelection()
})

describe("ModelRoute health", () => {
  test("starts with bounded first-token and rolling-window defaults", () => {
    expect(ModelRoute.policy()).toMatchObject({
      firstTokenTimeoutMs: 10_000,
      sampleWindow: 5,
      slowThreshold: 3,
      cooldownMs: 60_000,
    })
  })

  test("cools down immediately after a provider failure, then recovers", () => {
    const policy = ModelRoute.policy({ cooldownMs: 2_000 })

    ModelRoute.failed(target, policy, 10_000)

    expect(ModelRoute.coolingDown(target, 11_999)).toBe(true)
    expect(ModelRoute.coolingDown(target, 12_000)).toBe(false)
    expect(ModelRoute.cooldownUntil(target, 12_000)).toBe(0)
  })

  test("degrades after three slow completions in the rolling five-request window", () => {
    const policy = ModelRoute.policy({
      firstTokenTimeoutMs: false,
      maxResponseTimeMs: 1_000,
      sampleWindow: 5,
      slowThreshold: 3,
      cooldownMs: 2_000,
    })
    const fast = { firstTokenMs: 100, responseMs: 500, tokensPerSecond: 30 }
    const slow = { firstTokenMs: 100, responseMs: 1_001, tokensPerSecond: 30 }

    ModelRoute.completed(target, policy, slow, 1_000)
    ModelRoute.completed(target, policy, fast, 2_000)
    ModelRoute.completed(target, policy, slow, 3_000)
    expect(ModelRoute.coolingDown(target, 3_000)).toBe(false)
    ModelRoute.completed(target, policy, slow, 4_000)

    expect(ModelRoute.coolingDown(target, 4_000)).toBe(true)
    expect(ModelRoute.coolingDown(target, 6_000)).toBe(false)
  })

  test("evicts old slow samples as the rolling window advances", () => {
    const policy = ModelRoute.policy({
      firstTokenTimeoutMs: false,
      maxResponseTimeMs: 1_000,
      sampleWindow: 3,
      slowThreshold: 3,
      cooldownMs: 2_000,
    })
    const slow = { firstTokenMs: 100, responseMs: 2_000, tokensPerSecond: 30 }
    const fast = { firstTokenMs: 100, responseMs: 500, tokensPerSecond: 30 }

    ModelRoute.completed(target, policy, slow, 1_000)
    ModelRoute.completed(target, policy, slow, 2_000)
    ModelRoute.completed(target, policy, fast, 3_000)
    ModelRoute.completed(target, policy, fast, 4_000)

    expect(ModelRoute.coolingDown(target, 4_000)).toBe(false)
  })
})

describe("ModelRoute session selection", () => {
  test("ordered mode always starts at the first candidate and stays sticky", () => {
    expect(ModelRoute.sessionScoped("ordered")).toBe(false)
    expect(ModelRoute.selectSessionTarget("r", "s1", "ordered", [0, 1, 2], [1, 1, 1])).toBe(0)
    expect(ModelRoute.sessionTarget("r", "s1")).toBeUndefined()
  })

  test("round-robin rotates per session and sticks to the drawn target", () => {
    const indexes = [0, 1, 2]
    const first = ModelRoute.selectSessionTarget("rr", "s1", "round-robin", indexes, [1, 1, 1])
    const second = ModelRoute.selectSessionTarget("rr", "s2", "round-robin", indexes, [1, 1, 1])
    const third = ModelRoute.selectSessionTarget("rr", "s3", "round-robin", indexes, [1, 1, 1])
    expect([first, second, third]).toEqual([0, 1, 2])
    // Sticky while the drawn target is still a candidate.
    expect(ModelRoute.sessionTarget("rr", "s1")).toBe(0)
    expect(ModelRoute.selectSessionTarget("rr", "s1", "round-robin", [0, 2], [1, 1])).toBe(0)
    // If the sticky target left the candidate list (e.g. cooldown), the session re-draws and re-sticks.
    const redrawn = ModelRoute.selectSessionTarget("rr", "s1", "round-robin", [1, 2], [1, 1])
    expect(redrawn === 1 || redrawn === 2).toBe(true)
    expect(ModelRoute.sessionTarget("rr", "s1")).toBe(redrawn)
  })

  test("weighted selection respects ratios and sticks per session", () => {
    const indexes = [0, 1]
    let first = 0
    for (let i = 0; i < 200; i++) {
      const drawn = ModelRoute.selectSessionTarget(`w-${i}`, `s${i}`, "weighted", indexes, [3, 1])
      if (drawn === 0) first++
    }
    // 3:1 ratio over 200 draws; a tolerant band keeps this deterministic enough for CI.
    expect(first).toBeGreaterThan(120)
    expect(first).toBeLessThan(180)
    const sticky = ModelRoute.sessionTarget("w-0", "s0")
    expect(sticky).toBeDefined()
    expect(sticky).toBe(ModelRoute.selectSessionTarget("w-0", "s0", "weighted", indexes, [3, 1]))
  })

  test("forgetSession drops the sticky choice", () => {
    ModelRoute.selectSessionTarget("f", "s1", "round-robin", [0, 1], [1, 1])
    expect(ModelRoute.sessionTarget("f", "s1")).toBeDefined()
    ModelRoute.forgetSession("f", "s1")
    expect(ModelRoute.sessionTarget("f", "s1")).toBeUndefined()
  })
})
