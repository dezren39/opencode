import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Database } from "@opencode/core/database/database"
import { ModelRoute } from "@opencode/core/model-route"
import { Permission } from "@opencode/core/permission"
import { ModelRouteLog } from "@opencode/core/model-route-log"
import { AIError, QuotaExceededError } from "@opencode/ai"
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
            http: {
              status: 429,
              headers: {
                "x-ratelimit-remaining-tokens": "0",
                "retry-after": "60",
                "set-cookie": "must-not-be-persisted",
              },
            },
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
        quota: { headers: { "x-ratelimit-remaining-tokens": "0", "retry-after": "60" } },
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

describe("route stats tool permission", () => {
  it.live("applying suggestions needs approval; reading does not", () =>
    Effect.gen(function* () {
      ModelRoute.resetHealth()
      const now = Date.now()
      for (let index = 0; index < 6; index++)
        ModelRouteLog.record({
          kind: "attempt",
          row: attempt({
            provider_id: "denied",
            model_id: "m",
            time_started: now - 1_000 - index,
            time_ended: now - index,
            outcome: "failure",
            output_started: false,
          }),
        })
      yield* Effect.sleep("100 millis")

      const asked: unknown[] = []
      const register = (allow: boolean) => {
        let tool: { execute: (input: never, context: never) => Effect.Effect<unknown, unknown> } | undefined
        RouteStatsTool.add(
          { add: (added: unknown) => (tool = added as typeof tool) } as never,
          {
            assert: (input: unknown) =>
              Effect.sync(() => asked.push(input)).pipe(
                Effect.andThen(
                  allow
                    ? Effect.void
                    : Effect.fail(new Permission.BlockedError({ rules: [], permission: "route_stats", resources: [] })),
                ),
              ),
          } as never,
        )
        return (input: RouteStatsTool.Input) =>
          tool!.execute(input as never, { sessionID: "ses_x", agent: "build", messageID: "m", id: "c" } as never)
      }

      const read = yield* register(false)({ hours: 1 }).pipe(Effect.exit)
      expect(Exit.isSuccess(read)).toBe(true)
      expect(asked).toHaveLength(0)
      expect(ModelRoute.activeAdjustments()).toEqual([])

      const refused = yield* register(false)({ hours: 1, apply: true }).pipe(Effect.exit)
      expect(Exit.isFailure(refused)).toBe(true)
      expect(asked).toHaveLength(1)
      expect(ModelRoute.activeAdjustments()).toEqual([])

      const approved = yield* register(true)({ hours: 1, apply: true }).pipe(Effect.exit)
      expect(Exit.isSuccess(approved)).toBe(true)
      expect(ModelRoute.activeAdjustments().map((item) => item.id)).toContain("auto:denied/m")
    }),
  )
})

describe("ModelRouteLog.failureFields", () => {
  test("keeps quota headers, not arbitrary response headers or bodies", () => {
    const fields = ModelRouteLog.failureFields({
      _tag: "RateLimit",
      message: "rate limited",
      code: "429",
      body: "may echo request content",
      http: {
        status: 429,
        headers: {
          "x-ratelimit-limit-requests": "100",
          "x-ratelimit-remaining-requests": "0",
          "retry-after-ms": "5000",
          "set-cookie": "private",
          authorization: "secret",
        },
      },
    })
    expect(fields).toMatchObject({
      error_tag: "RateLimit",
      error_code: "429",
      error_status: 429,
      error_message: "rate limited",
      quota: {
        headers: {
          "x-ratelimit-limit-requests": "100",
          "x-ratelimit-remaining-requests": "0",
          "retry-after-ms": "5000",
        },
      },
    })
    // The body is opt-in, since it can echo the request.
    expect(fields.error_body).toBeUndefined()
    expect(JSON.stringify(fields)).not.toContain("private")
    expect(JSON.stringify(fields)).not.toContain("secret")
    expect(JSON.stringify(fields)).not.toContain("may echo")
    const captured = ModelRouteLog.failureFields(
      {
        _tag: "RateLimit",
        message: "rate limited",
        body: "may echo request content",
      },
      { captureBody: true },
    )
    expect(captured.error_body).toBe("may echo request content")
  })
})

describe("cooldown restore", () => {
  it.live("rebuilds cooldowns that are still running, and only those", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      ModelRoute.resetHealth()
      const now = Date.now()
      const health = (model_id: string, kind: string, time: number, until?: number) =>
        ModelRouteLog.record({
          kind: "health",
          // One provider per target: two cooling models of a provider would demote the provider itself.
          row: { time, provider_id: `restart-${model_id}`, model_id: "m", kind, until },
        })
      health("running", "cooldown-start", now - 5_000, now + 60_000)
      health("elapsed", "cooldown-start", now - 120_000, now - 60_000)
      health("recovered", "cooldown-start", now - 10_000, now + 60_000)
      health("recovered", "cooldown-end", now - 5_000)
      health("extended", "cooldown-start", now - 20_000, now + 10_000)
      health("extended", "cooldown-start", now - 5_000, now + 90_000)
      yield* Effect.sleep("100 millis")

      yield* ModelRouteLog.restoreCooldownsFrom(db)
      const cooling = (name: string) =>
        ModelRoute.coolingDown(ModelRoute.ref({ providerID: `restart-${name}`, model: "m" }))
      expect(cooling("running")).toBe(true)
      expect(cooling("elapsed")).toBe(false)
      expect(cooling("recovered")).toBe(false)
      expect(cooling("extended")).toBe(true)
      expect(ModelRoute.cooldownUntil(ModelRoute.ref({ providerID: "restart-extended", model: "m" }))).toBe(
        now + 90_000,
      )
    }),
  )
})

describe("rate-limit window restore", () => {
  it.live("holds targets back again after a restart while the provider's window is still open", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      ModelRoute.resetHealth()
      const now = Date.now()
      const window = (name: string, time: number, until: number) =>
        ModelRouteLog.record({
          kind: "health",
          row: { time, provider_id: `limit-${name}`, model_id: "m", kind: "rate-limit-window", until },
        })
      window("open", now - 5_000, now + 120_000)
      window("over", now - 200_000, now - 100_000)
      window("renewed", now - 50_000, now + 10_000)
      window("renewed", now - 5_000, now + 300_000)
      yield* Effect.sleep("100 millis")

      yield* ModelRouteLog.restoreCooldownsFrom(db)
      const until = (name: string) =>
        ModelRoute.limitedUntil(ModelRoute.ref({ providerID: `limit-${name}`, model: "m" }))
      expect(until("open")).toBe(now + 120_000)
      expect(until("over")).toBe(0)
      expect(until("renewed")).toBe(now + 300_000)
      // A window is the provider's forecast, not a failure: nothing is cooling.
      expect(ModelRoute.coolingDown(ModelRoute.ref({ providerID: "limit-open", model: "m" }))).toBe(false)
    }),
  )

  it.live("records a spent window as a health event the first time it is seen", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      ModelRoute.resetHealth()
      const target = ModelRoute.ref({ providerID: "limit-logged", model: "m" })
      const now = Date.now()
      const spent = { at: now, remaining: { requests: "0" }, reset: { requests: "45s" } }
      ModelRoute.observeRateLimit(target, spent, now)
      ModelRoute.observeRateLimit(target, spent, now + 1_000)
      yield* Effect.sleep("100 millis")
      const rows = (yield* db.select().from(RouteHealthTable).all()).filter((row) => row.provider_id === "limit-logged")
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ kind: "rate-limit-window", reason: "provider-reported", until: now + 45_000 })
    }),
  )
})

describe("cold-target rate-limit restore", () => {
  it.live("brings back the provider's last word, not just the hold", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      ModelRoute.resetHealth()
      const now = Date.now()
      // A successful attempt whose response advertised a nearly-spent window.
      ModelRouteLog.record({
        kind: "attempt",
        row: {
          time_started: now - 60_000,
          time_ended: now - 59_000,
          route_id: "r",
          provider_id: "cold",
          model_id: "m",
          outcome: "success",
          output_started: true,
          quota: {
            at: now - 60_000,
            limit: { requests: "60" },
            remaining: { requests: "2" },
            reset: { requests: "10m" },
          },
        },
      })
      yield* Effect.sleep("100 millis")

      yield* ModelRouteLog.restoreCooldownsFrom(db)
      const target = ModelRoute.ref({ providerID: "cold", model: "m" })
      // The snapshot itself is back, so route_stats can show it before first use.
      expect(ModelRoute.rateLimitOf(target)?.remaining).toEqual({ requests: "2" })
    }),
  )
})

describe("ModelRouteLog.observer", () => {
  it.live("records every call's attempt, so background generation is not invisible", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const now = Date.now()
      const observe = ModelRouteLog.observer({
        routeID: "titles",
        providerID: "openai",
        modelID: "small",
        sessionID: "ses_title",
        startedAt: now,
      })
      observe.done("success", {
        outputStarted: true,
        firstOutputAt: now + 12,
        tokens: { input: 30, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      yield* Effect.sleep("100 millis")
      const rows = yield* db.select().from(RouteAttemptTable).all()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        route_id: "titles",
        provider_id: "openai",
        model_id: "small",
        outcome: "success",
        output_started: true,
        tokens_input: 30,
        tokens_estimated: false,
      })
    }),
  )

  it.live("records a failed call with the exact error, and bodies when asked", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const failure = new AIError({
        reason: new QuotaExceededError({ message: "out of quota", body: '{"detail":"try again later"}' }),
      })
      ModelRouteLog.observer({
        routeID: "gen",
        providerID: "openai",
        modelID: "m",
        startedAt: Date.now(),
        captureBody: true,
      }).done("failure", { failure, outputStarted: false })
      yield* Effect.sleep("100 millis")
      const rows = yield* db.select().from(RouteAttemptTable).all()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        outcome: "failure",
        error_tag: "QuotaExceeded",
        error_message: "out of quota",
        error_body: '{"detail":"try again later"}',
      })
    }),
  )

  it.live("marks both legs of a hedged attempt", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const request = { routeID: "r", providerID: "openai", modelID: "m", startedAt: Date.now(), hedged: true }
      ModelRouteLog.observer(request).done("success", { outputStarted: true, firstOutputAt: Date.now() })
      ModelRouteLog.observer(request).done("hedged-out", { outputStarted: false })
      yield* Effect.sleep("100 millis")
      const rows = yield* db.select().from(RouteAttemptTable).all()
      expect(rows.map((row) => [row.outcome, row.hedged]).toSorted()).toEqual([
        ["hedged-out", true],
        ["success", true],
      ])
    }),
  )
})

describe("hedge accuracy", () => {
  it.live("scores each leg of a hedged pair", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const now = Date.now()
      const leg = (provider: string, outcome: "success" | "hedged-out") =>
        ModelRouteLog.observer({
          routeID: "r",
          providerID: provider,
          modelID: "m",
          assistantMessageID: "msg_hedge",
          startedAt: now,
          hedged: true,
        }).done(outcome, {
          outputStarted: outcome === "success",
          firstOutputAt: outcome === "success" ? now : undefined,
        })
      leg("openai", "hedged-out")
      leg("anthropic", "success")
      yield* Effect.sleep("100 millis")
      expect(yield* ModelRouteLog.hedgeAccuracy(db, 0)).toMatchObject([
        { providerID: "anthropic", modelID: "m", hedges: 1, wins: 1 },
        { providerID: "openai", modelID: "m", hedges: 1, wins: 0 },
      ])
    }),
  )
})
