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

describe("ModelRoute.orderTargets", () => {
  const targets = [0, 1, 2, 3].map((index) => ModelRoute.ref({ providerID: "p", model: `m${index}` }))
  // root: weighted 3:1 between group A (leaves 0,1 round-robin) and leaf 2; leaf 3 is a fallback.
  const definition = {
    id: "tree",
    targets,
    targetVariants: [],
    health: ModelRoute.policy(),
    nodes: [
      {
        selection: "weighted" as const,
        weights: [3, 1, 1],
        children: [{ node: 1 }, { leaf: 2 }, { leaf: 3 }],
      },
      { selection: "round-robin" as const, weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] },
    ],
  } as unknown as ModelRoute.Definition
  const all = new Set([0, 1, 2, 3])

  test("keeps every leaf and splits within the chosen group", () => {
    const first = ModelRoute.orderTargets(definition, all, "s1", true)
    expect([...first].sort()).toEqual([0, 1, 2, 3])
    // Group A's leaves stay adjacent: a group is chosen as one unit.
    const groupA = first.filter((index) => index < 2)
    expect(Math.abs(first.indexOf(groupA[0]) - first.indexOf(groupA[1]))).toBe(1)
  })

  test("is sticky per session at every level and drops cooled groups", () => {
    const first = ModelRoute.orderTargets(definition, all, "s2", true)
    expect(ModelRoute.orderTargets(definition, all, "s2", true)).toEqual(first)
    const withoutA = ModelRoute.orderTargets(definition, new Set([2, 3]), "s2", true)
    expect(withoutA.filter((index) => index < 2)).toEqual([])
    expect(withoutA).toHaveLength(2)
  })

  test("round-robin inside a group rotates across sessions", () => {
    const onlyA = new Set([0, 1])
    const heads = ["a", "b", "c", "d"].map((id) => ModelRoute.orderTargets(definition, onlyA, id, true)[0])
    expect(new Set(heads).size).toBe(2)
  })
})

describe("ModelRoute correlation and adjustments", () => {
  const policy = ModelRoute.policy({ cooldownMs: 60_000 })
  const model = (providerID: string, id: string) => ModelRoute.ref({ providerID, model: id })

  test("demotes a provider once several of its models are cooling, but not other providers", () => {
    ModelRoute.resetHealth()
    ModelRoute.failed(model("azure", "a"), policy, 1_000)
    expect(ModelRoute.coolingDown(model("azure", "b"), 1_000)).toBe(false)
    ModelRoute.failed(model("azure", "c"), policy, 1_000)
    expect(ModelRoute.coolingDown(model("azure", "b"), 1_000)).toBe(true)
    expect(ModelRoute.coolingDown(model("openai", "b"), 1_000)).toBe(false)
    expect(ModelRoute.coolingDown(model("azure", "b"), 62_000)).toBe(false)
  })

  test("does not punish targets when unrelated providers fail together", () => {
    ModelRoute.resetHealth()
    ModelRoute.failed(model("openai", "a"), policy, 1_000)
    ModelRoute.failed(model("azure", "a"), policy, 2_000)
    expect(ModelRoute.networkSuspect(2_000)).toBe(false)
    ModelRoute.failed(model("anthropic", "a"), policy, 3_000)
    expect(ModelRoute.networkSuspect(3_000)).toBe(true)
    expect(ModelRoute.coolingDown(model("anthropic", "a"), 3_000)).toBe(false)
    expect(ModelRoute.networkSuspect(40_000)).toBe(false)
  })

  test("skip and weight adjustments expire and reorder ordered groups", () => {
    ModelRoute.resetHealth()
    const targets = [model("openai", "gpt-6-luna"), model("anthropic", "claude-opus-5")]
    const definition = {
      id: "adj",
      targets,
      targetVariants: [],
      health: policy,
      nodes: [{ selection: "ordered" as const, weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] }],
    } as unknown as ModelRoute.Definition
    const now = Date.now()
    expect(ModelRoute.orderTargets(definition, new Set([0, 1]), "s", true)).toEqual([0, 1])
    ModelRoute.setAdjustments([{ id: "promo", match: "claude", action: "weight", factor: 5, until: now + 60_000 }])
    expect(ModelRoute.orderTargets(definition, new Set([0, 1]), "s", true)).toEqual([1, 0])
    ModelRoute.setAdjustments([{ id: "promo", match: "claude", action: "weight", factor: 5, until: now - 1 }])
    expect(ModelRoute.orderTargets(definition, new Set([0, 1]), "s", true)).toEqual([0, 1])
    ModelRoute.setAdjustments([{ id: "out", match: "openai/", action: "skip", until: now + 60_000 }])
    expect(ModelRoute.skipped(targets[0])).toBe(true)
    expect(ModelRoute.skipped(targets[1])).toBe(false)
  })
})

describe("ModelRoute failure hints", () => {
  const policy = ModelRoute.policy({ cooldownMs: 60_000, quotaCooldownMs: 900_000 })
  const t = ModelRoute.ref({ providerID: "openai", model: "hint" })

  test("a stated retry-after sets the cooldown, capped at a day", () => {
    ModelRoute.resetHealth()
    ModelRoute.failed(t, policy, 1_000, { retryAfterMs: 5_000 })
    expect(ModelRoute.cooldownUntil(t, 1_000)).toBe(6_000)
    ModelRoute.resetHealth()
    ModelRoute.failed(t, policy, 1_000, { retryAfterMs: 10 ** 12 })
    expect(ModelRoute.cooldownUntil(t, 1_000)).toBe(1_000 + 86_400_000)
  })

  test("an exhausted quota outlasts an ordinary failure", () => {
    ModelRoute.resetHealth()
    ModelRoute.failed(t, policy, 1_000, { quota: true })
    expect(ModelRoute.cooldownUntil(t, 1_000)).toBe(1_000 + 900_000)
    ModelRoute.resetHealth()
    ModelRoute.failed(t, policy, 1_000)
    expect(ModelRoute.cooldownUntil(t, 1_000)).toBe(1_000 + 60_000)
  })
})

describe("ModelRoute budgets", () => {
  const t = ModelRoute.ref({ providerID: "openai", model: "budgeted" })

  test("passes a target over once it reaches its soft limit, and frees it as the window moves", () => {
    ModelRoute.resetHealth()
    const budget = { requestsPerMinute: 10, softLimit: 0.5 }
    const start = 1_000_000
    for (let index = 0; index < 4; index++) ModelRoute.recordUsage(t, 100, start + index * 1_000)
    expect(ModelRoute.overBudget(t, budget, start + 5_000)).toBe(false)
    ModelRoute.recordUsage(t, 100, start + 5_000)
    expect(ModelRoute.overBudget(t, budget, start + 6_000)).toBe(true)
    expect(ModelRoute.usageOf(t, start + 6_000).minute).toEqual({ requests: 5, tokens: 500 })
    expect(ModelRoute.overBudget(t, budget, start + 70_000)).toBe(false)
    expect(ModelRoute.usageOf(t, start + 70_000).day.requests).toBe(5)
  })

  test("counts daily tokens and expires them after a day", () => {
    ModelRoute.resetHealth()
    const budget = { tokensPerDay: 1_000 }
    ModelRoute.recordUsage(t, 950, 1_000)
    expect(ModelRoute.overBudget(t, budget, 2_000)).toBe(true)
    expect(ModelRoute.overBudget(t, budget, 1_000 + 86_400_000 + 1)).toBe(false)
    expect(ModelRoute.overBudget(t, undefined, 2_000)).toBe(false)
  })

  test("seeds usage from stored history in order", () => {
    ModelRoute.resetHealth()
    ModelRoute.seedUsage([
      { time: 3_000, providerID: "openai", modelID: "budgeted", tokens: 30 },
      { time: 1_000, providerID: "openai", modelID: "budgeted", tokens: 10 },
    ])
    expect(ModelRoute.usageOf(t, 4_000).day).toEqual({ requests: 2, tokens: 40 })
  })
})

describe("ModelRoute.slow", () => {
  test("repeated slow losses cool a target down like any other slow one", () => {
    ModelRoute.resetHealth()
    const policy = ModelRoute.policy({ sampleWindow: 5, slowThreshold: 3, cooldownMs: 60_000 })
    const t = ModelRoute.ref({ providerID: "openai", model: "slowpoke" })
    ModelRoute.slow(t, policy, 1_000)
    ModelRoute.slow(t, policy, 2_000)
    expect(ModelRoute.coolingDown(t, 2_000)).toBe(false)
    ModelRoute.slow(t, policy, 3_000)
    expect(ModelRoute.coolingDown(t, 3_000)).toBe(true)
    expect(ModelRoute.coolingDown(t, 64_000)).toBe(false)
  })
})
