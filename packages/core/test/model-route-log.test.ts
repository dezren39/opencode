import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode/core/database/database"
import { ModelRoute } from "@opencode/core/model-route"
import { ModelRouteLog } from "@opencode/core/model-route-log"
import { RouteStatsTool } from "@opencode/core/tool/plugin/route-stats"
import { RouteAttemptTable, RouteDecisionTable, RouteHealthTable } from "@opencode/core/model-route-log/sql"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([ModelRouteLog.node, Database.node])))

const attempt = (overrides: Partial<ModelRouteLog.Attempt>): ModelRouteLog.Attempt => ({
  time_started: 1_000,
  time_ended: 2_000,
  route_id: "luna",
  provider_id: "openai",
  model_id: "gpt-6-luna",
  outcome: "success",
  output_started: true,
  ...overrides,
})

describe("ModelRouteLog", () => {
  it.live("persists decisions, attempts and health transitions asynchronously", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      ModelRouteLog.record({
        kind: "decision",
        row: {
          time: 1,
          route_id: "luna",
          selection: "weighted",
          candidates: ["openai/gpt-6-luna", "azure/gpt-6-luna"],
          chosen: "openai/gpt-6-luna",
          reason: "drawn",
        },
      })
      ModelRouteLog.record({ kind: "attempt", row: attempt({ first_token_ms: 100, response_ms: 900 }) })
      ModelRouteLog.record({
        kind: "attempt",
        row: attempt({
          outcome: "failure",
          output_started: false,
          ...ModelRouteLog.failureFields({
            _tag: "QuotaExceeded",
            message: "You exceeded your current quota",
            body: '{"error":{"code":"insufficient_quota"}}',
            http: { status: 429, headers: { "x-ratelimit-remaining-tokens": "0" } },
          }),
        }),
      })
      ModelRouteLog.record({
        kind: "health",
        row: { time: 3, provider_id: "openai", model_id: "gpt-6-luna", kind: "cooldown-start", reason: "failure" },
      })
      yield* Effect.sleep("100 millis")

      expect(yield* db.select().from(RouteDecisionTable).all()).toHaveLength(1)
      expect(yield* db.select().from(RouteHealthTable).all()).toHaveLength(1)
      const attempts = yield* db.select().from(RouteAttemptTable).all()
      expect(attempts).toHaveLength(2)
      expect(attempts.find((row) => row.outcome === "failure")).toMatchObject({
        error_tag: "QuotaExceeded",
        error_status: 429,
        error_message: "You exceeded your current quota",
        error_body: '{"error":{"code":"insufficient_quota"}}',
        quota: { headers: { "x-ratelimit-remaining-tokens": "0" } },
      })

      const stats = yield* ModelRouteLog.targetStats(db, 0, "luna")
      expect(stats).toHaveLength(1)
      expect(stats[0]).toMatchObject({ attempts: 2, failures: 1, avgFirstTokenMs: 100 })
      expect(yield* ModelRouteLog.recentFailures(db, 0)).toHaveLength(1)
    }),
  )
})

describe("route note restore", () => {
  it.live("restores active adjustments, drops expired and removed ones", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const now = Date.now()
      const add = (id: string, until: number, time: number) =>
        ModelRouteLog.record({
          kind: "note",
          row: {
            time,
            text: id,
            expires: until,
            interpreted: { op: "add", adjustment: { id, match: id, action: "skip", until } },
          },
        })
      add("keep", now + 60_000, now - 3)
      add("expired", now - 1, now - 2)
      add("removed", now + 60_000, now - 1)
      ModelRouteLog.record({
        kind: "note",
        row: { time: now, text: "remove", interpreted: { op: "remove", id: "removed" } },
      })
      yield* Effect.sleep("100 millis")

      ModelRoute.setAdjustments([])
      yield* ModelRouteLog.restoreNotes(db)
      expect(ModelRoute.activeAdjustments().map((item) => item.id)).toEqual(["keep"])
    }),
  )
})

describe("route usage restore", () => {
  it.live("rebuilds the last day of usage from stored attempts", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      ModelRoute.resetHealth()
      const now = Date.now()
      ModelRouteLog.record({
        kind: "attempt",
        row: attempt({
          provider_id: "restored",
          model_id: "m",
          time_started: now - 2_000,
          time_ended: now - 1_000,
          tokens_input: 10,
          tokens_output: 5,
          tokens_reasoning: 5,
        }),
      })
      ModelRouteLog.record({
        kind: "attempt",
        row: attempt({
          provider_id: "restored",
          model_id: "m",
          time_started: now - 3 * 86_400_000,
          time_ended: now - 3 * 86_400_000 + 1_000,
          tokens_input: 999,
        }),
      })
      yield* Effect.sleep("100 millis")
      yield* ModelRouteLog.restoreUsageFrom(db)
      expect(ModelRoute.usageOf(ModelRoute.ref({ providerID: "restored", model: "m" })).day).toEqual({
        requests: 1,
        tokens: 20,
      })
    }),
  )
})

describe("route stats tool", () => {
  it.live("reports per-target stats and exact errors, and suggests from them", () =>
    Effect.gen(function* () {
      ModelRoute.resetHealth()
      const now = Date.now()
      for (let index = 0; index < 6; index++)
        ModelRouteLog.record({
          kind: "attempt",
          row: attempt({
            provider_id: "flaky",
            model_id: "m",
            time_started: now - 1_000 - index,
            time_ended: now - index,
            outcome: index < 4 ? "failure" : "success",
            output_started: index >= 4,
            ...(index < 4
              ? ModelRouteLog.failureFields({
                  _tag: "ProviderInternal",
                  message: `upstream said no ${index}`,
                  http: { status: 503, headers: {} },
                })
              : {}),
          }),
        })
      yield* Effect.sleep("100 millis")

      const report = yield* RouteStatsTool.collect({ hours: 1 })
      const flaky = report.targets.find((row) => row.providerID === "flaky")
      expect(flaky).toMatchObject({ attempts: 6, failures: 4 })
      expect(report.errors.find((error) => error.providerID === "flaky")).toMatchObject({
        tag: "ProviderInternal",
        status: 503,
        count: 4,
      })
      expect(report.errors.find((error) => error.providerID === "flaky")?.lastMessage).toStartWith("upstream said no")
      expect(report.suggestions.map((item) => item.match)).toContain("flaky/m")
    }),
  )
})
