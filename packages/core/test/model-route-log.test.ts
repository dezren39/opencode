import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode/core/database/database"
import { ModelRouteLog } from "@opencode/core/model-route-log"
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
