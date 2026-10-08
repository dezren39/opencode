import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ModelRoute } from "@opencode/core/model-route"
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
