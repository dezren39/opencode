import { afterEach, describe, expect, test } from "bun:test"
import { ModelRoute } from "@opencode/core/model-route"

const target = ModelRoute.ref({ providerID: "openai", model: "gpt-6-luna" })

afterEach(() => ModelRoute.resetHealth())

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
