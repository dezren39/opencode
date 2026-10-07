export * as ModelRouteAutonomy from "./model-route-autonomy.js"

/**
 * How much a route may decide for itself. Each level includes everything below it.
 *
 * - `fixed`: the configured order, with failover. No weights, budgets or adjustments.
 * - `rules`: adds selection modes, weights, budgets and provider rate-limit holds.
 * - `adaptive`: adds the scheduled review, which skips or down-weights targets from recent history.
 * - `predictive`: adds time-of-day and error-text prediction to that review.
 * - `agent`: adds `route_stats` and `route_adjust`, so the model can inspect and steer routing.
 */
export const LEVELS = ["fixed", "rules", "adaptive", "predictive", "agent"] as const
export type Level = (typeof LEVELS)[number]

/** A route with no `autonomy` keeps the behavior it had before levels existed. */
export const rank = (level: Level | undefined) => (level === undefined ? undefined : LEVELS.indexOf(level))

const atLeast = (level: Level | undefined, minimum: Level) => (rank(level) ?? -1) >= LEVELS.indexOf(minimum)

/** Weights, selection modes and budgets apply from `rules` up; an unset level keeps them. */
export const usesRules = (level: Level | undefined) => level === undefined || atLeast(level, "rules")

/** The scheduled review runs when a route asks for `adaptive` or more, or when tuning is enabled. */
export const reviews = (levels: readonly (Level | undefined)[], tuningEnabled: boolean) =>
  tuningEnabled || levels.some((level) => atLeast(level, "adaptive"))

/** Prediction runs for `predictive` and `agent` routes; with no levels set it follows the review. */
export const predicts = (levels: readonly (Level | undefined)[]) =>
  levels.every((level) => level === undefined) || levels.some((level) => atLeast(level, "predictive"))

/** The agent tools are offered when any route is `agent` or has no level at all. */
export const offersTools = (levels: readonly (Level | undefined)[]) =>
  levels.some((level) => level === undefined || level === "agent")
