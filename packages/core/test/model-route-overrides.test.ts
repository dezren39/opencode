import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ModelRoute } from "@opencode/core/model-route"
import { ModelRouteInterpret } from "@opencode/core/model-route-interpret"
import { ModelRouteOverrides } from "@opencode/core/model-route-overrides"

const DAY = 86_400_000
const now = Date.now()
const anthropic = ModelRoute.ref({ providerID: "anthropic", model: "claude-opus-4-1" })
const openai = ModelRoute.ref({ providerID: "openai", model: "gpt-6-luna" })
const draft = (over: Partial<ModelRouteOverrides.Override>): ModelRouteOverrides.Override => ({
  id: "t",
  action: "avoid",
  providers: [],
  models: [],
  routes: [],
  fixed: true,
  until: now + DAY,
  text: "",
  source: "user",
  createdAt: now,
  ...over,
})

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-overrides-"))
  ModelRouteOverrides.setFilePath(path.join(dir, "route-overrides.json"))
  ModelRoute.resetHealth()
})
afterEach(() => {
  ModelRouteOverrides.setFilePath(undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("ModelRouteOverrides matching", () => {
  test("provider names match regardless of case, and models match wildcards", () => {
    const item = draft({ providers: ["Anthropic"], models: ["*opus*"] })
    expect(ModelRouteOverrides.applies(item, anthropic, now)).toBe(true)
    expect(ModelRouteOverrides.applies(item, openai, now)).toBe(false)
    const sonnet = ModelRoute.ref({ providerID: "anthropic", model: "claude-sonnet-4" })
    expect(ModelRouteOverrides.applies(item, sonnet, now)).toBe(false)
  })

  test("a provider with no model pattern covers all its models, and expiry ends it", () => {
    const item = draft({ providers: ["openai"], until: now + 1_000 })
    expect(ModelRouteOverrides.applies(item, openai, now)).toBe(true)
    expect(ModelRouteOverrides.applies(item, openai, now + 1_000)).toBe(false)
  })

  test("an entry that names nothing is dropped, so it can never apply to everything", () => {
    expect(
      ModelRouteOverrides.parse({ overrides: [{ id: "x", action: "avoid", providers: [], models: [], until: now }] }),
    ).toEqual([])
    expect(
      ModelRouteOverrides.parse({ overrides: [{ id: "x", action: "nuke", providers: ["a"], until: now }] }),
    ).toEqual([])
  })
})

describe("ModelRouteOverrides storage", () => {
  test("a saved override is read back, and expired ones are dropped on save", () => {
    ModelRouteOverrides.save(
      [draft({ id: "live", providers: ["openai"] }), draft({ id: "old", providers: ["openai"], until: now - 1 })],
      now,
    )
    expect(ModelRouteOverrides.current().map((item) => item.id)).toEqual(["live"])
  })

  test("a missing or corrupt file means no overrides, never an error", () => {
    expect(ModelRouteOverrides.current()).toEqual([])
    fs.writeFileSync(ModelRouteOverrides.filePath(), "{ not json")
    expect(ModelRouteOverrides.current()).toEqual([])
  })

  test("the file is separate from the config and holds only overrides", () => {
    ModelRouteOverrides.add(draft({ id: "a", providers: ["openai"] }), now)
    const stored = JSON.parse(fs.readFileSync(ModelRouteOverrides.filePath(), "utf8"))
    expect(stored.version).toBe(1)
    expect(stored.overrides.map((item: { id: string }) => item.id)).toEqual(["a"])
    ModelRouteOverrides.remove("a", now)
    expect(ModelRouteOverrides.current()).toEqual([])
  })
})

describe("user overrides in routing", () => {
  test("avoid takes a target out of rotation until it expires", () => {
    ModelRouteOverrides.add(draft({ providers: ["openai"] }), now)
    expect(ModelRoute.userSkipped(openai, now)).toBe(true)
    expect(ModelRoute.userSkipped(anthropic, now)).toBe(false)
    expect(ModelRoute.userSkipped(openai, now + DAY + 1)).toBe(false)
  })

  test("prefer raises a target's weight", () => {
    expect(ModelRoute.weightFactor(anthropic, now)).toBe(1)
    ModelRouteOverrides.add(draft({ action: "prefer", providers: ["anthropic"] }), now)
    expect(ModelRoute.weightFactor(anthropic, now)).toBe(3)
  })

  test("allow-over-budget lets a target run past its soft budget", () => {
    const budget = { requestsPerDay: 1 }
    ModelRoute.recordUsage(anthropic, 0, now)
    ModelRoute.recordUsage(anthropic, 0, now)
    expect(ModelRoute.overBudget(anthropic, budget, now)).toBe(true)
    ModelRouteOverrides.add(draft({ action: "allow-over-budget", providers: ["anthropic"] }), now)
    expect(ModelRoute.overBudget(anthropic, budget, now)).toBe(false)
  })
})

const context = (models: { providerID: string; id: string }[] = []) => ({
  now,
  providers: ["anthropic", "openai"],
  models,
})

describe("interpreting a sentence", () => {
  test("a named provider with a time is decided with certainty", async () => {
    const result = await ModelRouteInterpret.interpret("stop using anthropic for the rest of the day", context(), {
      keywords: true,
      local: false,
      external: false,
    })
    expect(result).toMatchObject({ status: "decided", confidence: "certain" })
    if (result.status !== "decided") throw new Error("expected a decision")
    expect(result.drafts).toEqual([expect.objectContaining({ action: "avoid", providers: ["anthropic"], models: [] })])
    expect(result.drafts[0].until).toBeGreaterThan(now)
    expect(result.drafts[0].until).toBeLessThanOrEqual(now + DAY)
  })

  test("'claude' may mean the provider or every Claude model, so it asks once", () => {
    const result = ModelRouteInterpret.keywords("don't use claude anymore today", context())
    expect(result.status).toBe("clarify")
    if (result.status !== "clarify") throw new Error("expected a question")
    expect(result.options.map((option) => option.drafts[0].providers.concat(option.drafts[0].models))).toEqual([
      ["anthropic"],
      ["*claude*"],
    ])
  })

  test("excluding a model family asks whether it means every provider", () => {
    const result = ModelRouteInterpret.keywords("avoid opus today", context())
    expect(result.status).toBe("clarify")
  })

  test("preferring a family picks the newest version on each provider", () => {
    const models = [
      { providerID: "anthropic", id: "claude-opus-4" },
      { providerID: "anthropic", id: "claude-opus-4-1-20250805" },
      { providerID: "anthropic", id: "claude-sonnet-4-5" },
      { providerID: "openai", id: "opus-3" },
    ]
    const result = ModelRouteInterpret.keywords("use opus", context(models))
    expect(result).toMatchObject({ status: "decided" })
    if (result.status !== "decided") throw new Error("expected a decision")
    expect(result.drafts.map((draft) => draft.models)).toEqual([["claude-opus-4-1-20250805"], ["opus-3"]])
  })

  test("a provider being down is an avoid until the stated time", () => {
    const result = ModelRouteInterpret.keywords("openai is down for 3 hours", context())
    expect(result).toMatchObject({ status: "decided", confidence: "certain" })
    if (result.status !== "decided") throw new Error("expected a decision")
    expect(result.drafts[0]).toMatchObject({ action: "avoid", providers: ["openai"] })
    expect(result.drafts[0].until).toBeGreaterThanOrEqual(now + 3 * 3_600_000 - 1_000)
  })

  test("pool membership and nonsense are reported, not guessed at", () => {
    expect(ModelRouteInterpret.keywords("include all sonnet in any pool", context()).status).toBe("unknown")
    expect(ModelRouteInterpret.keywords("hello there", context()).status).toBe("unknown")
  })

  test("a disabled keyword stage is not used", async () => {
    const result = await ModelRouteInterpret.interpret("stop using openai", context(), {
      keywords: false,
      local: false,
      external: false,
    })
    expect(result.status).toBe("unknown")
  })

  test("a smarter stage that decides overrides a tentative keyword answer", async () => {
    const external = async () => ({
      status: "decided" as const,
      stage: "external",
      confidence: "certain" as const,
      drafts: [{ action: "avoid" as const, providers: ["openai"], models: [], until: now + 1, text: "" }],
      summary: "",
    })
    const result = await ModelRouteInterpret.interpret("stop using openai", context(), undefined, { external })
    expect(result).toMatchObject({ status: "decided", stage: "external" })
  })
})

describe("priority, lighter, and the fixed-route facet", () => {
  const sonnet = ModelRoute.ref({ providerID: "anthropic", model: "claude-sonnet-4" })
  const fixedScope = { routeID: "r", fixed: true }
  const rulesScope = { routeID: "r", fixed: false }

  test("an avoid reaches fixed routes by default", () => {
    ModelRouteOverrides.add(draft({ providers: ["openai"] }), now)
    expect(ModelRoute.userSkipped(openai, now, fixedScope)).toBe(true)
    expect(ModelRoute.userSkipped(openai, now, rulesScope)).toBe(true)
  })

  test("an override marked not-fixed stops short of fixed routes", () => {
    ModelRouteOverrides.add(draft({ providers: ["openai"], fixed: false }), now)
    expect(ModelRoute.userSkipped(openai, now, fixedScope)).toBe(false)
    expect(ModelRoute.userSkipped(openai, now, rulesScope)).toBe(true)
  })

  test("an override limited to one route does not touch another", () => {
    ModelRouteOverrides.add(draft({ providers: ["openai"], routes: ["other"] }), now)
    expect(ModelRoute.userSkipped(openai, now, { routeID: "r", fixed: true })).toBe(false)
    expect(ModelRoute.userSkipped(openai, now, { routeID: "other", fixed: true })).toBe(true)
  })

  test("prefer reorders a fixed route's order and raises a target's weight", () => {
    ModelRoute.resetHealth()
    const targets = [openai, sonnet]
    const definition = {
      id: "r",
      targets,
      targetVariants: [],
      health: ModelRoute.policy(),
      autonomy: "fixed",
      nodes: [{ selection: "ordered" as const, weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] }],
    } as unknown as ModelRoute.Definition
    expect(ModelRoute.orderTargets(definition, new Set([0, 1]), undefined, false)).toEqual([0, 1])
    ModelRouteOverrides.add(draft({ action: "prefer", providers: ["anthropic"] }), now)
    expect(ModelRoute.orderTargets(definition, new Set([0, 1]), undefined, false)).toEqual([1, 0])
  })

  test("a lighter preference moves a target down and carries its own factor", () => {
    ModelRouteOverrides.add(draft({ action: "prefer", providers: ["anthropic"], factor: 1 / 3 }), now)
    expect(ModelRoute.weightFactor(sonnet, now, rulesScope)).toBeCloseTo(1 / 3)
  })

  test("learned weights do not reorder a fixed route, but do on a route that lets the tuner decide", () => {
    ModelRoute.resetHealth()
    ModelRoute.setAdjustments([
      { id: "auto:w", match: "anthropic/claude-sonnet-4", action: "weight", factor: 5, until: now + DAY },
    ])
    expect(ModelRoute.weightFactor(sonnet, now, fixedScope)).toBe(1)
    expect(ModelRoute.weightFactor(sonnet, now, rulesScope)).toBe(5)
    ModelRoute.setAdjustments([])
  })
})

describe("interpreting priority and facets", () => {
  const context = { now, providers: ["anthropic", "openai"], models: [] }

  test("'use opus less today' lowers priority rather than raising it", () => {
    const result = ModelRouteInterpret.keywords("use anthropic opus less today", context)
    if (result.status !== "decided") throw new Error("expected a decision")
    expect(result.drafts[0]).toMatchObject({ action: "prefer", factor: 1 / 3 })
  })

  test("a stated multiple sets the factor", () => {
    const result = ModelRouteInterpret.keywords("prefer openai 2x", context)
    if (result.status !== "decided") throw new Error("expected a decision")
    expect(result.drafts[0]).toMatchObject({ action: "prefer", factor: 2 })
  })

  test("'except on fixed routes' stops the override short of fixed routes", () => {
    const result = ModelRouteInterpret.keywords("prefer anthropic except on fixed routes", context)
    if (result.status !== "decided") throw new Error("expected a decision")
    expect(result.drafts[0]).toMatchObject({ fixed: false })
  })

  test("drafts become stored overrides that keep their facets", () => {
    const [override] = ModelRouteInterpret.toOverrides(
      [{ action: "prefer", providers: ["openai"], models: [], factor: 3, fixed: false, until: now + DAY, text: "x" }],
      "user",
      now,
    )
    expect(override).toMatchObject({ action: "prefer", providers: ["openai"], factor: 3, fixed: false, source: "user" })
  })
})
