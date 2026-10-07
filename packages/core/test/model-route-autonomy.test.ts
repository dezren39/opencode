import { describe, expect, test } from "bun:test"
import { ModelRouteAutonomy } from "@opencode/core/model-route-autonomy"

describe("ModelRouteAutonomy", () => {
  test("fixed drops weights and budgets; every higher level and an unset level keeps them", () => {
    expect(ModelRouteAutonomy.usesRules("fixed")).toBe(false)
    for (const level of [undefined, "rules", "adaptive", "predictive", "agent"] as const)
      expect(ModelRouteAutonomy.usesRules(level)).toBe(true)
  })

  test("the review runs for adaptive and above, or when tuning is enabled", () => {
    expect(ModelRouteAutonomy.reviews(["fixed", "rules"], false)).toBe(false)
    expect(ModelRouteAutonomy.reviews(["rules", "adaptive"], false)).toBe(true)
    expect(ModelRouteAutonomy.reviews([undefined], false)).toBe(false)
    expect(ModelRouteAutonomy.reviews(["fixed"], true)).toBe(true)
  })

  test("prediction needs predictive or above, and stays on when no level is set", () => {
    expect(ModelRouteAutonomy.predicts(["adaptive"])).toBe(false)
    expect(ModelRouteAutonomy.predicts(["adaptive", "predictive"])).toBe(true)
    expect(ModelRouteAutonomy.predicts([undefined])).toBe(true)
  })

  test("the agent tools are offered only for agent or unset routes", () => {
    expect(ModelRouteAutonomy.offersTools(["predictive"])).toBe(false)
    expect(ModelRouteAutonomy.offersTools(["predictive", "agent"])).toBe(true)
    expect(ModelRouteAutonomy.offersTools([undefined])).toBe(true)
  })
})
