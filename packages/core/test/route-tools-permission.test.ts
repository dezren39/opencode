import { afterEach, describe, expect, test } from "bun:test"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect, Exit } from "effect"
import { ModelRoute } from "@opencode/core/model-route"
import { Permission } from "@opencode/core/permission"
import { RouteAdjustTool } from "@opencode/core/tool/plugin/route-adjust"

afterEach(() => ModelRoute.resetHealth())

type Asked = Parameters<Permission.Interface["assert"]>[0]

/** The tool exactly as the plugin registers it, with a permission service that records or denies. */
const registered = (decide: (input: Asked) => Effect.Effect<void, Permission.BlockedError>) => {
  const asked: Asked[] = []
  let tool: { execute: (input: never, context: never) => Effect.Effect<unknown, unknown> } | undefined
  const editor = { add: (added: unknown) => (tool = added as typeof tool) } as unknown as ToolEditor
  RouteAdjustTool.add(editor, {
    assert: (input: Asked) => Effect.sync(() => asked.push(input)).pipe(Effect.andThen(decide(input))),
  } as unknown as Permission.Interface)
  const run = (input: RouteAdjustTool.Input) =>
    Effect.runPromiseExit(
      tool!.execute(input as never, { sessionID: "ses_x", agent: "build", messageID: "msg_x", id: "call_x" } as never),
    )
  return { asked, run }
}

const denied = () =>
  Effect.fail(new Permission.BlockedError({ rules: [], permission: "route_adjust", resources: ["claude"] }))

describe("route_adjust permission", () => {
  test("a denied change fails with a permission error and records nothing", async () => {
    const { asked, run } = registered(denied)
    const exit = await run({ action: "add", match: "claude", effect: "weight", factor: 4, hours: 72 })
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("Permission denied: route_adjust")
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ action: "route_adjust", resources: ["claude"], sessionID: "ses_x" })
    expect(ModelRoute.activeAdjustments()).toEqual([])
  })

  test("a denied removal leaves the adjustment in force", async () => {
    ModelRoute.addAdjustment({ id: "keep", match: "glm", action: "skip", until: Date.now() + 60_000 })
    const { run } = registered(denied)
    const exit = await run({ action: "remove", id: "keep" })
    expect(Exit.isFailure(exit)).toBe(true)
    expect(ModelRoute.activeAdjustments().map((item) => item.id)).toEqual(["keep"])
  })

  test("an approved change is recorded, and listing never asks", async () => {
    const { asked, run } = registered(() => Effect.void)
    expect(Exit.isSuccess(await run({ action: "add", match: "claude", effect: "skip", hours: 1 }))).toBe(true)
    expect(ModelRoute.activeAdjustments().map((item) => item.match)).toEqual(["claude"])
    expect(asked).toHaveLength(1)
    expect(Exit.isSuccess(await run({ action: "list" }))).toBe(true)
    expect(asked).toHaveLength(1)
  })
})
