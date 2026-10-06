import { afterEach, describe, expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { Database } from "@opencode/core/database/database"
import { ModelRoute } from "@opencode/core/model-route"
import { ModelRouteLog } from "@opencode/core/model-route-log"
import { ModelRouteTuning } from "@opencode/core/model-route-tuning"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([ModelRouteLog.node, Database.node])))

afterEach(() => ModelRoute.resetHealth())

const failures = (provider: string, count: number) => {
  const now = Date.now()
  for (let index = 0; index < count; index++)
    ModelRouteLog.record({
      kind: "attempt",
      row: {
        time_started: now - 1_000 - index,
        time_ended: now - index,
        route_id: "r",
        provider_id: provider,
        model_id: "m",
        outcome: "failure",
        output_started: false,
      },
    })
}

const settle = TestClock.adjust("1 millis").pipe(Effect.andThen(Effect.yieldNow), Effect.repeat({ times: 5 }))

const none = undefined as ModelRouteTuning.Settings | undefined

describe("scheduled tuning", () => {
  it.effect("reviews on the interval when enabled and applies what the history argues for", () =>
    Effect.gen(function* () {
      failures("scheduled", 8)
      yield* settle
      let settings: ModelRouteTuning.Settings | undefined = { enabled: true, intervalMinutes: 10 }
      const fiber = yield* ModelRouteTuning.schedule(() => settings).pipe(Effect.forkChild)

      yield* TestClock.adjust("9 minutes")
      expect(ModelRoute.activeAdjustments()).toEqual([])
      yield* TestClock.adjust("2 minutes")
      yield* settle
      const applied = ModelRoute.activeAdjustments()
      expect(applied.map((item) => item.id)).toEqual(["auto:scheduled/m"])
      // Held for two intervals, so it bridges to the next review.
      expect(applied[0].until - Date.now()).toBeGreaterThan(19 * 60_000 - 1_000)

      settings = { enabled: false, intervalMinutes: 10 }
      ModelRoute.setAdjustments([])
      yield* TestClock.adjust("30 minutes")
      yield* settle
      expect(ModelRoute.activeAdjustments()).toEqual([])
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.effect("does nothing without settings, and a failed review does not stop the schedule", () =>
    Effect.gen(function* () {
      failures("quiet", 8)
      yield* settle
      const fiber = yield* ModelRouteTuning.schedule(() => none).pipe(Effect.forkChild)
      yield* TestClock.adjust("60 minutes")
      yield* settle
      expect(ModelRoute.activeAdjustments()).toEqual([])
      yield* Fiber.interrupt(fiber)
    }),
  )
})
