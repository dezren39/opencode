import { afterEach, describe, expect, test } from "bun:test"
import { ModelRoute } from "@opencode/core/model-route"
import { RouteAdjustTool } from "@opencode/core/tool/plugin/route-adjust"

afterEach(() => ModelRoute.resetHealth())

describe("route_adjust", () => {
  test("adds, lists and removes an expiring weight adjustment", () => {
    const added = RouteAdjustTool.apply({
      action: "add",
      match: "claude",
      effect: "weight",
      factor: 4,
      hours: 72,
      note: "promo credits expire in three days",
    })
    expect(added.content).toContain("weight x4")
    const target = ModelRoute.ref({ providerID: "anthropic", model: "claude-opus-5" })
    expect(ModelRoute.weightFactor(target)).toBe(4)
    expect(ModelRoute.weightFactor(ModelRoute.ref({ providerID: "openai", model: "gpt-6-luna" }))).toBe(1)
    expect(RouteAdjustTool.apply({ action: "list" }).content).toContain("promo credits")
    expect(RouteAdjustTool.apply({ action: "remove", id: "weight-claude" }).content).toBe("Removed weight-claude")
    expect(ModelRoute.weightFactor(target)).toBe(1)
  })

  test("refuses an incomplete add and a skip applies to matching targets only", () => {
    expect(RouteAdjustTool.apply({ action: "add", match: "glm" }).content).toContain("needs match")
    RouteAdjustTool.apply({ action: "add", match: "glm", effect: "skip", hours: 8 })
    expect(ModelRoute.skipped(ModelRoute.ref({ providerID: "zai", model: "glm-5" }))).toBe(true)
    expect(ModelRoute.skipped(ModelRoute.ref({ providerID: "openai", model: "gpt-6-luna" }))).toBe(false)
  })
})
