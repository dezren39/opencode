import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"

// Append-only routing telemetry. Deliberately no foreign keys: rows outlive the sessions they describe,
// and `session_id` / `assistant_message_id` are join keys into the event-sourced session tables, which
// already hold per-step usage, cost and errors. Prompts and response contents are never stored here.

/** One target selection for a session turn: what was eligible, what was drawn, and why. */
export const RouteDecisionTable = sqliteTable(
  "route_decision",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    time: integer().notNull(),
    session_id: text(),
    route_id: text().notNull(),
    selection: text().notNull(),
    variant: text(),
    /** Eligible `provider/model` targets in the order they would be tried. */
    candidates: text({ mode: "json" }).$type<string[]>().notNull(),
    chosen: text(),
    /** `ordered`, `sticky`, `drawn`, `redrawn` or `all-cooling`. */
    reason: text().notNull(),
    /** Overrides and cooldowns that shaped this decision. */
    detail: text({ mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [
    index("route_decision_route_time_idx").on(table.route_id, table.time),
    index("route_decision_session_idx").on(table.session_id, table.time),
  ],
)

/** One provider request against one concrete target, with its exact outcome. */
export const RouteAttemptTable = sqliteTable(
  "route_attempt",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    time_started: integer().notNull(),
    time_ended: integer().notNull(),
    session_id: text(),
    assistant_message_id: text(),
    route_id: text().notNull(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    variant: text(),
    /** `success`, `failure`, `timeout` or `interrupted`. */
    outcome: text().notNull(),
    error_tag: text(),
    error_code: text(),
    error_status: integer(),
    error_message: text(),
    retryable: integer({ mode: "boolean" }),
    output_started: integer({ mode: "boolean" }).notNull(),
    failed_over_to: text(),
    first_token_ms: real(),
    response_ms: real(),
    tokens_per_second: real(),
    tokens_input: integer(),
    /** True when a request was cancelled before the provider returned usage. */
    tokens_estimated: integer({ mode: "boolean" }),
    tokens_output: integer(),
    tokens_reasoning: integer(),
    tokens_cache_read: integer(),
    tokens_cache_write: integer(),
    /** Provider rate-limit and quota headers or fields, when the error carried them. */
    quota: text({ mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [
    index("route_attempt_target_time_idx").on(table.provider_id, table.model_id, table.time_started),
    index("route_attempt_route_time_idx").on(table.route_id, table.time_started),
    index("route_attempt_session_idx").on(table.session_id, table.time_started),
  ],
)

/** Cooldown and degradation transitions of a target. */
export const RouteHealthTable = sqliteTable(
  "route_health",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    time: integer().notNull(),
    route_id: text(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    /** `cooldown-start` or `cooldown-end`. */
    kind: text().notNull(),
    reason: text(),
    until: integer(),
  },
  (table) => [index("route_health_target_time_idx").on(table.provider_id, table.model_id, table.time)],
)

/** Free-form operator input that the routing layer turns into expiring adjustments. */
export const RouteNoteTable = sqliteTable(
  "route_note",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    time: integer().notNull(),
    /** The note as written, untouched. */
    text: text().notNull(),
    /** Structured interpretation: skip, prefer, weight, quota, or an explanation of a past failure. */
    interpreted: text({ mode: "json" }).$type<Record<string, unknown>>(),
    expires: integer(),
  },
  (table) => [index("route_note_time_idx").on(table.time)],
)
