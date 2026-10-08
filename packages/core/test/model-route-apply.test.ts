import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ModelRouteApply } from "@opencode/core/model-route-apply"
import { ModelRouteInterpret } from "@opencode/core/model-route-interpret"
import { ModelRouteOverrides } from "@opencode/core/model-route-overrides"

const now = Date.now()
const context = (): ModelRouteInterpret.Context => ({
  now,
  providers: ["anthropic", "openai"],
  models: [{ providerID: "anthropic", id: "claude-opus-4-1" }],
})
const keywordsOnly: ModelRouteInterpret.Toggles = { keywords: true, local: false, external: false }

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-apply-"))
  ModelRouteOverrides.setFilePath(path.join(dir, "route-overrides.json"))
})
afterEach(() => {
  ModelRouteOverrides.setFilePath(undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

const feedback = () => {
  const file = path.join(dir, "route-feedback.jsonl")
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
}

describe("applying an interpreted sentence", () => {
  test("a certain decision is stored as an override and logged as accepted", async () => {
    const outcome = await ModelRouteApply.interpret(
      "stop using anthropic for the rest of the day",
      context(),
      keywordsOnly,
    )
    expect(outcome.status).toBe("applied")
    if (outcome.status !== "applied") throw new Error("expected applied")
    expect(ModelRouteOverrides.current()).toEqual([
      expect.objectContaining({ action: "avoid", providers: ["anthropic"], source: "user" }),
    ])
    expect(feedback()).toEqual([
      expect.objectContaining({ text: "stop using anthropic for the rest of the day", accepted: true }),
    ])
  })

  test("an ambiguous sentence is returned as a question and stores nothing", async () => {
    const outcome = await ModelRouteApply.interpret("don't use claude anymore today", context(), keywordsOnly)
    expect(outcome.status).toBe("clarify")
    expect(ModelRouteOverrides.current()).toEqual([])
    expect(feedback()).toEqual([])
  })

  test("choosing an option stores its drafts and logs the correction", async () => {
    const outcome = await ModelRouteApply.interpret("don't use claude anymore today", context(), keywordsOnly)
    if (outcome.status !== "clarify") throw new Error("expected a question")
    const applied = ModelRouteApply.answer("don't use claude anymore today", outcome.options[1], now)
    expect(applied.status).toBe("applied")
    expect(ModelRouteOverrides.current()).toEqual([expect.objectContaining({ models: ["*claude*"], providers: [] })])
    expect(feedback()).toEqual([expect.objectContaining({ accepted: "corrected" })])
  })

  test("an unknown sentence changes nothing", async () => {
    const outcome = await ModelRouteApply.interpret("make it nicer", context(), keywordsOnly)
    expect(outcome.status).toBe("unknown")
    expect(ModelRouteOverrides.current()).toEqual([])
  })
})
