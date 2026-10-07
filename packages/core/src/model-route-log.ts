export * as ModelRouteLog from "./model-route-log.js"

import { and, asc, count, desc, eq, gt, gte, isNull, or, sql } from "drizzle-orm"
import { Effect, Layer, Queue } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Database } from "./database/database.js"
import { RouteAttemptTable, RouteDecisionTable, RouteHealthTable, RouteNoteTable } from "./model-route-log/sql.js"

export type Decision = typeof RouteDecisionTable.$inferInsert
export type Attempt = typeof RouteAttemptTable.$inferInsert
export type Health = typeof RouteHealthTable.$inferInsert
export type Note = typeof RouteNoteTable.$inferInsert

export type Event =
  | { readonly kind: "decision"; readonly row: Decision }
  | { readonly kind: "attempt"; readonly row: Attempt }
  | { readonly kind: "health"; readonly row: Health }
  | { readonly kind: "note"; readonly row: Note }

type Sink = (event: Event) => void

// Routing runs on the hot path of every turn. Call sites only hand over a plain row; persistence is
// asynchronous, batched and never able to fail a request. Without an installed sink events are dropped.
let sink: Sink | undefined

export const record = (event: Event) => {
  try {
    sink?.(event)
  } catch {
    // Telemetry must never affect routing.
  }
}

/** Installs the writer and returns the function that removes it again. Test seam and node wiring. */
export const setSink = (next: Sink | undefined) => {
  sink = next
}

/** Flattens an `AIError.reason` into the exact tag, code, status, message and body, plus any
 * rate-limit detail the provider reported. */
export const failureFields = (reason: unknown) => {
  const value = (reason ?? {}) as Record<string, unknown>
  const http = value.http as { status?: unknown; headers?: unknown } | undefined
  const rateLimit = value.rateLimit as Record<string, unknown> | undefined
  const headers = http?.headers as Record<string, unknown> | undefined
  const quotaHeaders = headers
    ? Object.fromEntries(
        Object.entries(headers).filter(([name]) => /^(?:x-)?ratelimit-|^retry-after(?:-|$)/i.test(name)),
      )
    : undefined
  const retryAfterMs = typeof value.retryAfterMs === "number" ? value.retryAfterMs : undefined
  const quota =
    rateLimit || retryAfterMs !== undefined || Object.keys(quotaHeaders ?? {}).length > 0
      ? {
          ...rateLimit,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          ...(quotaHeaders ? { headers: quotaHeaders } : {}),
        }
      : undefined
  return {
    error_tag: typeof value._tag === "string" ? value._tag : undefined,
    error_code: typeof value.code === "string" ? value.code : undefined,
    error_status: typeof http?.status === "number" ? http.status : undefined,
    error_message: typeof value.message === "string" ? value.message : undefined,
    quota,
  }
}

const persist = (db: Database.Interface["db"], events: readonly Event[]) =>
  Effect.gen(function* () {
    const decisions = events.flatMap((event) => (event.kind === "decision" ? [event.row] : []))
    const attempts = events.flatMap((event) => (event.kind === "attempt" ? [event.row] : []))
    const health = events.flatMap((event) => (event.kind === "health" ? [event.row] : []))
    if (decisions.length) yield* db.insert(RouteDecisionTable).values(decisions).run()
    if (attempts.length) yield* db.insert(RouteAttemptTable).values(attempts).run()
    if (health.length) yield* db.insert(RouteHealthTable).values(health).run()
    const notes = events.flatMap((event) => (event.kind === "note" ? [event.row] : []))
    if (notes.length) yield* db.insert(RouteNoteTable).values(notes).run()
  })

/** Receives the still-active adjustments stored by earlier runs. Set by the routing module, which
 * this one cannot import without a cycle. */
let restore: ((notes: readonly Record<string, unknown>[]) => void) | undefined

export const onRestore = (next: typeof restore) => {
  restore = next
}

type UsageRow = { time: number; providerID: string; modelID: string; tokens: number }
let restoreUsage: ((rows: readonly UsageRow[]) => void) | undefined

export const onRestoreUsage = (next: typeof restoreUsage) => {
  restoreUsage = next
}

type CooldownRow = { providerID: string; modelID: string; until: number }
let restoreCooldowns: ((rows: readonly CooldownRow[]) => void) | undefined

export const onRestoreCooldowns = (next: typeof restoreCooldowns) => {
  restoreCooldowns = next
}

/** Cooldowns still in force, rebuilt from the health history so a restart does not send traffic
 * straight back to a target that was just failing. */
export const restoreCooldownsFrom = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    const now = Date.now()
    const rows = yield* db
      .select()
      .from(RouteHealthTable)
      .where(
        and(
          gte(RouteHealthTable.time, now - 86_400_000),
          or(eq(RouteHealthTable.kind, "cooldown-start"), eq(RouteHealthTable.kind, "cooldown-end")),
        ),
      )
      .orderBy(asc(RouteHealthTable.time), asc(RouteHealthTable.id))
      .all()
      .pipe(Effect.orElseSucceed(() => []))
    const latest = new Map<string, CooldownRow>()
    for (const row of rows) {
      const id = `${row.provider_id}/${row.model_id}`
      if (row.kind === "cooldown-end") latest.delete(id)
      else if (row.until !== null)
        latest.set(id, { providerID: row.provider_id, modelID: row.model_id, until: row.until })
    }
    restoreCooldowns?.([...latest.values()].filter((row) => row.until > now))
  })

/** Usage of the last day, so budgets survive a restart. */
export const restoreUsageFrom = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    const rows = yield* db
      .select({
        time: RouteAttemptTable.time_ended,
        providerID: RouteAttemptTable.provider_id,
        modelID: RouteAttemptTable.model_id,
        input: RouteAttemptTable.tokens_input,
        output: RouteAttemptTable.tokens_output,
        reasoning: RouteAttemptTable.tokens_reasoning,
      })
      .from(RouteAttemptTable)
      .where(gte(RouteAttemptTable.time_ended, Date.now() - 86_400_000))
      .all()
      .pipe(Effect.orElseSucceed(() => []))
    restoreUsage?.(
      rows.map((row) => ({
        time: row.time,
        providerID: row.providerID,
        modelID: row.modelID,
        tokens: (row.input ?? 0) + (row.output ?? 0) + (row.reasoning ?? 0),
      })),
    )
  })

/** Hands still-active stored notes to the routing module. Runs when the node starts. */
export const restoreNotes = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    const stored = yield* db
      .select()
      .from(RouteNoteTable)
      .where(or(isNull(RouteNoteTable.expires), gt(RouteNoteTable.expires, Date.now())))
      .orderBy(asc(RouteNoteTable.time))
      .all()
      .pipe(Effect.orElseSucceed(() => []))
    restore?.(stored.flatMap((row) => (row.interpreted ? [row.interpreted] : [])))
  })

let activeDb: Database.Interface["db"] | undefined

/** Runs a read against the routing database, or yields nothing when no database is attached. */
export const withDb = <A, E>(use: (db: Database.Interface["db"]) => Effect.Effect<A, E>) =>
  activeDb ? Effect.asSome(use(activeDb)) : Effect.succeedNone

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    activeDb = db
    yield* Effect.addFinalizer(() => Effect.sync(() => void (activeDb = undefined)))
    yield* restoreNotes(db)
    yield* restoreUsageFrom(db)
    yield* restoreCooldownsFrom(db)
    const queue = yield* Queue.unbounded<Event>()
    setSink((event) => void Queue.offerUnsafe(queue, event))
    yield* Effect.addFinalizer(() => Effect.sync(() => setSink(undefined)))
    yield* Queue.takeAll(queue).pipe(
      Effect.flatMap((events) =>
        persist(db, events).pipe(
          Effect.catchCause((cause) => Effect.logWarning("failed to persist model route telemetry", { cause })),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    )
  }),
)

/** Global so every location shares one writer; the resolver depends on it so it starts with routing. */
export const node = makeGlobalNode({ name: "model-route-log", layer, deps: [Database.node] })

export interface TargetStats {
  readonly providerID: string
  readonly modelID: string
  readonly attempts: number
  readonly failures: number
  readonly timeouts: number
  readonly avgFirstTokenMs: number | null
  readonly avgResponseMs: number | null
  readonly avgTokensPerSecond: number | null
}

/** Per-target reliability and latency since `since` (ms epoch): the view a tuning agent reads. */
export const targetStats = (db: Database.Interface["db"], since: number, routeID?: string) =>
  db
    .select({
      providerID: RouteAttemptTable.provider_id,
      modelID: RouteAttemptTable.model_id,
      attempts: count(),
      failures: sql<number>`sum(case when ${RouteAttemptTable.outcome} in ('failure','timeout') then 1 else 0 end)`,
      timeouts: sql<number>`sum(case when ${RouteAttemptTable.outcome} = 'timeout' then 1 else 0 end)`,
      avgFirstTokenMs: sql<number | null>`avg(${RouteAttemptTable.first_token_ms})`,
      avgResponseMs: sql<number | null>`avg(${RouteAttemptTable.response_ms})`,
      avgTokensPerSecond: sql<number | null>`avg(${RouteAttemptTable.tokens_per_second})`,
    })
    .from(RouteAttemptTable)
    .where(
      and(gte(RouteAttemptTable.time_started, since), routeID ? eq(RouteAttemptTable.route_id, routeID) : undefined),
    )
    .groupBy(RouteAttemptTable.provider_id, RouteAttemptTable.model_id)
    .all()

/** Most recent failures with their exact code and message, newest first. */
export const recentFailures = (db: Database.Interface["db"], since: number, limit = 100) =>
  db
    .select()
    .from(RouteAttemptTable)
    .where(and(gte(RouteAttemptTable.time_started, since), sql`${RouteAttemptTable.outcome} != 'success'`))
    .orderBy(desc(RouteAttemptTable.time_started))
    .limit(limit)
    .all()

export interface ErrorBreakdown {
  readonly providerID: string
  readonly modelID: string
  readonly tag: string | null
  readonly code: string | null
  readonly status: number | null
  readonly count: number
  readonly lastTime: number
  readonly lastMessage: string | null
}

/** Failures grouped by exact tag, code and HTTP status, with the latest message of each group. */
export const errorBreakdown = (db: Database.Interface["db"], since: number) =>
  db
    .select({
      providerID: RouteAttemptTable.provider_id,
      modelID: RouteAttemptTable.model_id,
      tag: RouteAttemptTable.error_tag,
      code: RouteAttemptTable.error_code,
      status: RouteAttemptTable.error_status,
      count: count(),
      lastTime: sql<number>`max(${RouteAttemptTable.time_started})`,
      lastMessage: sql<
        string | null
      >`(select e.error_message from route_attempt e where e.provider_id = ${RouteAttemptTable.provider_id} and e.model_id = ${RouteAttemptTable.model_id} and e.error_tag is ${RouteAttemptTable.error_tag} and e.error_code is ${RouteAttemptTable.error_code} and e.error_status is ${RouteAttemptTable.error_status} order by e.time_started desc limit 1)`,
    })
    .from(RouteAttemptTable)
    .where(and(gte(RouteAttemptTable.time_started, since), sql`${RouteAttemptTable.outcome} != 'success'`))
    .groupBy(
      RouteAttemptTable.provider_id,
      RouteAttemptTable.model_id,
      RouteAttemptTable.error_tag,
      RouteAttemptTable.error_code,
      RouteAttemptTable.error_status,
    )
    .orderBy(desc(count()))
    .all()
