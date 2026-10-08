export * as ModelRoute from "./model-route.js"

import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Schema } from "effect"
import { ModelRouteLimits } from "./model-route-limits.js"
import { ModelRouteAutonomy } from "./model-route-autonomy.js"
import { ModelRouteLog } from "./model-route-log.js"
import { ModelRouteOverrides } from "./model-route-overrides.js"
import { optional, PositiveInt } from "@opencode/schema/schema"

export const PROVIDER_ID = Provider.ID.make("opencode-route")
export const SETTING = "opencodeRoute"

const Policy = Schema.Struct({
  firstTokenTimeoutMs: Schema.Union([PositiveInt, Schema.Literal(false)]),
  maxResponseTimeMs: PositiveInt.pipe(optional),
  minOutputTokensPerSecond: Schema.Finite.check(Schema.isGreaterThan(0)).pipe(optional),
  sampleWindow: PositiveInt,
  slowThreshold: PositiveInt,
  cooldownMs: PositiveInt,
  /** Cooldown after the provider reports an exhausted quota without saying when it resets. */
  quotaCooldownMs: PositiveInt,
})

const TargetVariant = Schema.Struct({
  default: Model.VariantID.pipe(optional),
  map: Schema.Record(Schema.String, Model.VariantID).pipe(optional),
})

const Mode = Schema.Literals(["ordered", "round-robin", "weighted"])

/** A group of targets with its own selection mode. Children are leaf target indexes or nested
 * groups; `weights` is parallel to `children`. Group 0 is the route itself. */
const Node = Schema.Struct({
  /** Route id at this point in the hierarchy. */
  routeID: Schema.String.pipe(optional),
  selection: Mode,
  weights: Schema.Array(Schema.Finite.check(Schema.isGreaterThan(0))),
  children: Schema.Array(Schema.Struct({ leaf: Schema.Finite.pipe(optional), node: Schema.Finite.pipe(optional) })),
})

const Budget = Schema.Struct({
  requestsPerMinute: Schema.Finite.pipe(optional),
  requestsPerDay: Schema.Finite.pipe(optional),
  tokensPerMinute: Schema.Finite.pipe(optional),
  tokensPerDay: Schema.Finite.pipe(optional),
  softLimit: Schema.Finite.pipe(optional),
})

export type Budget = typeof Budget.Type

const Definition = Schema.Struct({
  id: Model.ID,
  targets: Schema.Array(Model.Ref),
  targetVariants: Schema.Array(TargetVariant),
  health: Policy,
  attempts: Schema.Finite.pipe(optional),
  hedgeAfterMs: Schema.Finite.pipe(optional),
  /** Decision level of the route; see ModelRouteAutonomy. Unset keeps every rule on. */
  autonomy: Schema.Literals(["fixed", "rules", "adaptive", "predictive", "agent"]).pipe(optional),
  /** Parallel to `targets`; an empty object means unlimited. */
  budgets: Schema.Array(Budget).pipe(optional),
  nodes: Schema.Array(Node),
})

/** A concrete provider/model a route sends requests to. */
export type Target = Model.Ref
export type Node = typeof Node.Type
export type Policy = typeof Policy.Type
export type Definition = typeof Definition.Type

const DEFAULT_POLICY: Policy = {
  firstTokenTimeoutMs: 10_000,
  sampleWindow: 5,
  slowThreshold: 3,
  cooldownMs: 60_000,
  quotaCooldownMs: 900_000,
}

export const policy = (input?: {
  readonly firstTokenTimeoutMs?: number | false
  readonly maxResponseTimeMs?: number
  readonly minOutputTokensPerSecond?: number
  readonly sampleWindow?: number
  readonly slowThreshold?: number
  readonly cooldownMs?: number
  readonly quotaCooldownMs?: number
}): Policy => {
  const sampleWindow = Math.min(input?.sampleWindow ?? DEFAULT_POLICY.sampleWindow, 50)
  return {
    firstTokenTimeoutMs: input?.firstTokenTimeoutMs ?? DEFAULT_POLICY.firstTokenTimeoutMs,
    // Unset thresholds are omitted, not undefined: the stored definition rejects explicit undefined.
    ...(input?.maxResponseTimeMs !== undefined ? { maxResponseTimeMs: input.maxResponseTimeMs } : {}),
    ...(input?.minOutputTokensPerSecond !== undefined
      ? { minOutputTokensPerSecond: input.minOutputTokensPerSecond }
      : {}),
    sampleWindow,
    slowThreshold: Math.min(input?.slowThreshold ?? DEFAULT_POLICY.slowThreshold, sampleWindow),
    cooldownMs: Math.min(input?.cooldownMs ?? DEFAULT_POLICY.cooldownMs, 3_600_000),
    quotaCooldownMs: Math.min(input?.quotaCooldownMs ?? DEFAULT_POLICY.quotaCooldownMs, 86_400_000),
  }
}

export const definition = (model: Model.Info): Definition | undefined => {
  if (model.providerID !== PROVIDER_ID) return
  const value = model.settings?.[SETTING]
  const result = Schema.decodeUnknownOption(Definition)(value)
  return result._tag === "Some" ? result.value : undefined
}

export const ref = (target: { providerID: string; model: string; variant?: string }): Model.Ref =>
  Model.Ref.make({
    providerID: Provider.ID.make(target.providerID),
    id: Model.ID.make(target.model),
    ...(target.variant ? { variant: Model.VariantID.make(target.variant) } : {}),
  })

const health = new Map<string, { samples: boolean[]; outcomes: boolean[]; cooldownUntil: number }>()
const HEALTH_LIMIT = 2_000
// Recent finished requests per target (true = answered). A target with at most one give-up in this
// window is steady: a single failure there is treated as transient before the route moves on.
const OUTCOME_WINDOW = 5

const key = (target: Model.Ref) => `${target.providerID}/${target.id}`

const pushOutcome = (outcomes: boolean[], answered: boolean) => [...outcomes, answered].slice(-OUTCOME_WINDOW)

const entry = (target: Model.Ref) => {
  const id = key(target)
  const current = health.get(id) ?? { samples: [], outcomes: [], cooldownUntil: 0 }
  health.delete(id)
  health.set(id, current)
  while (health.size > HEALTH_LIMIT) health.delete(health.keys().next().value!)
  return current
}

const logHealth = (
  target: Model.Ref,
  kind: "cooldown-start" | "cooldown-end" | "network-suspect" | "rate-limit-window",
  reason: string,
  until?: number,
) =>
  ModelRouteLog.record({
    kind: "health",
    row: { time: Date.now(), provider_id: target.providerID, model_id: target.id, kind, reason, until },
  })

const recover = (target: Model.Ref, state: { samples: boolean[]; cooldownUntil: number }, now: number) => {
  if (state.cooldownUntil === 0 || state.cooldownUntil > now) return
  state.cooldownUntil = 0
  state.samples = []
  logHealth(target, "cooldown-end", "expired")
}

// A provider-wide fault looks different from a model-specific one. When several models of the same
// provider are cooling the provider itself is demoted to last resort; when several unrelated
// providers fail at once the fault is more likely the user's network than any target, so none is
// punished.
const NETWORK_WINDOW_MS = 30_000
const NETWORK_PROVIDERS = 3
const PROVIDER_MODELS = 2
const recentFailures: Array<{ readonly provider: string; readonly target: string; readonly time: number }> = []

/** True when failures hit many unrelated providers within a short window. */
export const networkSuspect = (now = Date.now()) =>
  new Set(
    recentFailures.filter((failure) => now - failure.time <= NETWORK_WINDOW_MS).map((failure) => failure.provider),
  ).size >= NETWORK_PROVIDERS

const providerCooldownUntil = (providerID: string, now: number) => {
  const prefix = `${providerID}/`
  let count = 0
  let until = 0
  for (const [id, state] of health) {
    if (!id.startsWith(prefix) || state.cooldownUntil <= now) continue
    count++
    until = Math.max(until, state.cooldownUntil)
  }
  return count >= PROVIDER_MODELS ? until : 0
}

export const coolingDown = (target: Model.Ref, now = Date.now()) => cooldownUntil(target, now) > now

export const cooldownUntil = (target: Model.Ref, now = Date.now()) => {
  const state = health.get(key(target))
  if (state) recover(target, state, now)
  return Math.max(state?.cooldownUntil ?? 0, providerCooldownUntil(target.providerID, now))
}

const MAX_COOLDOWN_MS = 86_400_000

/** Why a request failed, as far as the cooldown is concerned: a provider that says when it recovers
 * is believed, an exhausted quota outlasts an ordinary error. */
export interface FailureHint {
  readonly retryAfterMs?: number
  readonly quota?: boolean
  /** A local transport failure with no provider HTTP response. */
  readonly network?: boolean
}

export const failed = (target: Model.Ref, policy: Policy, now = Date.now(), hint?: FailureHint) => {
  // Quota, rate-limit and provider HTTP errors are not evidence of an internet outage.
  if (hint?.quota) recordQuota(target, now)
  if (hint?.network) recentFailures.push({ provider: target.providerID, target: key(target), time: now })
  while (recentFailures.length > 200 || (recentFailures[0] && now - recentFailures[0].time > NETWORK_WINDOW_MS))
    recentFailures.shift()
  if (hint?.network && networkSuspect(now)) {
    // Undo the cooldowns from the earlier correlated transport errors too: those requests likely
    // shared the same local outage, so treating each provider as independently unhealthy is wrong.
    for (const failure of recentFailures) {
      const prior = health.get(failure.target)
      if (prior && prior.cooldownUntil > now) {
        prior.cooldownUntil = 0
        prior.samples = []
      }
    }
    logHealth(target, "network-suspect", "transport failures across unrelated providers; target cooldowns cleared")
    return
  }
  const state = entry(target)
  state.samples = []
  state.outcomes = pushOutcome(state.outcomes, false)
  const cooldown =
    hint?.retryAfterMs !== undefined && hint.retryAfterMs > 0
      ? Math.min(Math.max(hint.retryAfterMs, 1_000), MAX_COOLDOWN_MS)
      : hint?.quota
        ? policy.quotaCooldownMs
        : policy.cooldownMs
  state.cooldownUntil = now + cooldown
  logHealth(
    target,
    "cooldown-start",
    hint?.retryAfterMs ? "retry-after" : hint?.quota ? "quota" : "failure",
    state.cooldownUntil,
  )
}

/** Counts a request that was given up on for being slow, so a target that keeps losing hedges
 * eventually cools down like any other slow one. */
export const slow = (target: Model.Ref, policy: Policy, now = Date.now()) => {
  const state = entry(target)
  recover(target, state, now)
  if (state.cooldownUntil > now) return
  state.samples.push(true)
  if (state.samples.length > policy.sampleWindow) state.samples.shift()
  if (state.samples.filter(Boolean).length >= policy.slowThreshold) {
    state.samples = []
    state.cooldownUntil = now + policy.cooldownMs
    logHealth(target, "cooldown-start", "slow", state.cooldownUntil)
  }
}

/** Tunable behaviour. Users never need to set these; they exist so the thresholds can be changed
 * without a code change. Defaults are what a route does when nothing is configured. */
export interface Settings {
  readonly escalation: {
    /** After this many give-ups in the recent window, a route races its next target at once. */
    readonly enabled: boolean
    readonly afterGiveUps: number
  }
  readonly quota: {
    /** Quota errors within `windowMs` that move a target to the end of the route's order. */
    readonly demoteAfter: number
    readonly windowMs: number
  }
}

const DEFAULT_SETTINGS: Settings = {
  escalation: { enabled: true, afterGiveUps: 2 },
  quota: { demoteAfter: 3, windowMs: 4 * 3_600_000 },
}

let settings: Settings = DEFAULT_SETTINGS

export const configure = (
  next: Partial<{ escalation: Partial<Settings["escalation"]>; quota: Partial<Settings["quota"]> }>,
) => {
  settings = {
    escalation: { ...settings.escalation, ...next.escalation },
    quota: { ...settings.quota, ...next.quota },
  }
}

export const currentSettings = () => settings

/** Give-ups among a target's recent requests. */
export const giveUps = (target: Model.Ref) => {
  const state = health.get(key(target))
  return (state?.outcomes ?? []).filter((answered) => !answered).length
}

/** A target is steady while it has at most one give-up among its recent requests. */
export const steady = (target: Model.Ref) => giveUps(target) < settings.escalation.afterGiveUps

/** A route should race its next target immediately when its current target keeps giving up. */
export const escalates = (target: Model.Ref) => settings.escalation.enabled && !steady(target)

// Quota errors are recorded per target so a provider that keeps saying "out of quota" drops to the end
// of every order, instead of being retried first on each new session.
const quotaEvents = new Map<string, number[]>()

/** True when a target has hit its quota errors often enough recently to be put last. */
export const demoted = (target: Model.Ref, now = Date.now()) => {
  const recent = (quotaEvents.get(key(target)) ?? []).filter((at) => now - at <= settings.quota.windowMs)
  return recent.length >= settings.quota.demoteAfter
}

const recordQuota = (target: Model.Ref, now: number) => {
  const id = key(target)
  const recent = (quotaEvents.get(id) ?? []).filter((at) => now - at <= settings.quota.windowMs)
  quotaEvents.set(id, [...recent, now].slice(-50))
}

export const completed = (
  target: Model.Ref,
  policy: Policy,
  sample: { readonly firstTokenMs: number; readonly responseMs: number; readonly tokensPerSecond: number },
  now = Date.now(),
) => {
  const state = entry(target)
  state.outcomes = pushOutcome(state.outcomes, true)
  recover(target, state, now)
  if (state.cooldownUntil > now) return
  const slow =
    (typeof policy.firstTokenTimeoutMs === "number" && sample.firstTokenMs > policy.firstTokenTimeoutMs) ||
    (policy.maxResponseTimeMs !== undefined && sample.responseMs > policy.maxResponseTimeMs) ||
    (policy.minOutputTokensPerSecond !== undefined && sample.tokensPerSecond < policy.minOutputTokensPerSecond)
  state.samples.push(slow)
  if (state.samples.length > policy.sampleWindow) state.samples.shift()
  if (state.samples.filter(Boolean).length >= policy.slowThreshold) {
    state.samples = []
    state.cooldownUntil = now + policy.cooldownMs
    logHealth(target, "cooldown-start", "slow", state.cooldownUntil)
  }
}

/** Test seam; health is intentionally process-local and never persists prompts or request contents. */
export const resetHealth = () => {
  limits.clear()
  usage.clear()
  adjustments = []
  health.clear()
  quotaEvents.clear()
  continuity.clear()
  recentFailures.length = 0
}

/** Per-route selection state: rotation counters for round-robin, sticky session choices, both
 * process-local like health. */
const selection = new Map<string, { cursor: number; sessions: Map<string, number>; scores: Map<number, number> }>()
const SESSION_LIMIT = 5_000

const selectionEntry = (routeID: string) => {
  let current = selection.get(routeID)
  if (!current) {
    current = { cursor: 0, sessions: new Map(), scores: new Map() }
    selection.set(routeID, current)
  }
  return current
}

/** True when the selection mode picks a target per session rather than always starting at the
 * first healthy one. */
export const sessionScoped = (mode: "ordered" | "round-robin" | "weighted") => mode !== "ordered"

/** The sticky target index chosen for this session, if one was already made. */
export const sessionTarget = (routeID: string, sessionID: string) => {
  const state = selection.get(routeID)
  const index = state?.sessions.get(sessionID)
  return index === undefined ? undefined : index
}

/** Chooses the session's target index. `ordered` always returns the first entry; round-robin
 * advances a shared cursor; weighted draws by relative ratio. Only the outcome is sticky. */
export const selectSessionTarget = (
  routeID: string,
  sessionID: string,
  mode: "ordered" | "round-robin" | "weighted",
  candidateIndexes: readonly number[],
  weights: readonly number[],
  random: () => number = Math.random,
): number | undefined => {
  if (candidateIndexes.length === 0) return undefined
  const first = candidateIndexes[0]
  if (mode === "ordered") return first
  const state = selectionEntry(routeID)
  const sticky = state.sessions.get(sessionID)
  if (sticky !== undefined && candidateIndexes.includes(sticky)) return sticky
  let chosen: number
  if (mode === "round-robin") {
    // Smooth weighted round robin. Equal weights are ordinary round robin; weights and
    // user-supplied preference factors become stable ratios without random session-to-session
    // variance.
    const total = candidateIndexes.reduce((sum, index) => sum + (weights[index] ?? 1), 0)
    chosen = candidateIndexes[0]
    let greatest = Number.NEGATIVE_INFINITY
    for (const index of candidateIndexes) {
      const score = (state.scores.get(index) ?? 0) + (weights[index] ?? 1)
      state.scores.set(index, score)
      if (score > greatest) {
        greatest = score
        chosen = index
      }
    }
    state.scores.set(chosen, (state.scores.get(chosen) ?? 0) - total)
    state.cursor = (state.cursor + 1) % Number.MAX_SAFE_INTEGER
  } else {
    const total = candidateIndexes.reduce((sum, index) => sum + (weights[index] ?? 1), 0)
    let draw = random() * total
    chosen = candidateIndexes[candidateIndexes.length - 1]
    for (const index of candidateIndexes) {
      draw -= weights[index] ?? 1
      if (draw <= 0) {
        chosen = index
        break
      }
    }
  }
  state.sessions.set(sessionID, chosen)
  while (state.sessions.size > SESSION_LIMIT) {
    const oldest = state.sessions.keys().next().value
    if (oldest === undefined) break
    state.sessions.delete(oldest)
  }
  return chosen
}

// Usage per target in 6-second buckets, enough for per-minute and per-day allowances without
// remembering individual requests.
const BUCKET_MS = 6_000
const DAY_MS = 86_400_000
const usage = new Map<
  string,
  { buckets: Array<{ at: number; requests: number; tokens: number }>; day: { requests: number; tokens: number } }
>()

const usageEntry = (target: Model.Ref) => {
  const id = key(target)
  let current = usage.get(id)
  if (!current) {
    current = { buckets: [], day: { requests: 0, tokens: 0 } }
    usage.set(id, current)
  }
  return current
}

const prune = (state: ReturnType<typeof usageEntry>, now: number) => {
  while (state.buckets.length > 0 && state.buckets[0].at <= now - DAY_MS) {
    const old = state.buckets.shift()!
    state.day.requests -= old.requests
    state.day.tokens -= old.tokens
  }
}

/** Counts one request and its tokens against the target. */
export const recordUsage = (target: Model.Ref, tokens: number, now = Date.now()) => {
  const state = usageEntry(target)
  prune(state, now)
  const at = Math.floor(now / BUCKET_MS) * BUCKET_MS
  const last = state.buckets.at(-1)
  if (last && last.at === at) {
    last.requests += 1
    last.tokens += tokens
  } else if (!last || last.at < at) state.buckets.push({ at, requests: 1, tokens })
  else return // Restored history older than what is already recorded is added in order by the caller.
  state.day.requests += 1
  state.day.tokens += tokens
  while (usage.size > HEALTH_LIMIT) usage.delete(usage.keys().next().value!)
}

/** Requests and tokens used by the target in the last minute and the last day. */
export const usageOf = (target: Model.Ref, now = Date.now()) => {
  const state = usage.get(key(target))
  if (!state) return { minute: { requests: 0, tokens: 0 }, day: { requests: 0, tokens: 0 } }
  prune(state, now)
  const minute = { requests: 0, tokens: 0 }
  for (let index = state.buckets.length - 1; index >= 0 && state.buckets[index].at > now - 60_000; index--) {
    minute.requests += state.buckets[index].requests
    minute.tokens += state.buckets[index].tokens
  }
  return { minute, day: { ...state.day } }
}

/** True when any allowance in `budget` is used up to its soft limit. */
export const overBudget = (
  target: Model.Ref,
  budget: Budget | undefined,
  now = Date.now(),
  scope: ModelRouteOverrides.Scope = {},
) => {
  if (!budget || userOverride("allow-over-budget", target, now, scope)) return false
  const soft = budget.softLimit ?? 0.9
  const used = usageOf(target, now)
  const over = (value: number, limit: number | undefined) => limit !== undefined && value >= limit * soft
  return (
    over(used.minute.requests, budget.requestsPerMinute) ||
    over(used.day.requests, budget.requestsPerDay) ||
    over(used.minute.tokens, budget.tokensPerMinute) ||
    over(used.day.tokens, budget.tokensPerDay)
  )
}

/** Rebuilds usage from stored history, oldest first, after a restart. */
export const seedUsage = (
  rows: ReadonlyArray<{ time: number; providerID: string; modelID: string; tokens: number }>,
) => {
  for (const row of rows.toSorted((left, right) => left.time - right.time))
    recordUsage(ModelRoute_ref(row.providerID, row.modelID), row.tokens, row.time)
}

const ModelRoute_ref = (providerID: string, modelID: string) => ref({ providerID, model: modelID })

// What each provider last said about its rate-limit windows, and how long that holds the target
// back. Kept apart from cooldowns: this is the provider's own forecast, not a failure.
const limits = new Map<string, { snapshot?: ModelRouteLimits.Snapshot; until: number }>()

/** Records a response's rate-limit snapshot. A spent window holds the target back until it resets. */
export const observeRateLimit = (
  target: Model.Ref,
  snapshot: ModelRouteLimits.Snapshot | undefined,
  now = Date.now(),
) => {
  if (!snapshot) return
  const id = key(target)
  const until = ModelRouteLimits.holdUntil(snapshot, now)
  const previous = limits.get(id)
  limits.delete(id)
  limits.set(id, { snapshot, until })
  while (limits.size > HEALTH_LIMIT) limits.delete(limits.keys().next().value!)
  if (until > now && (previous?.until ?? 0) < until - 1_000)
    logHealth(target, "rate-limit-window", "provider-reported", until)
}

/** Until when the provider's own numbers say to leave the target alone; 0 when they don't. */
export const limitedUntil = (target: Model.Ref, now = Date.now()) => {
  const state = limits.get(key(target))
  return state && state.until > now ? state.until : 0
}

/** The latest rate-limit snapshot seen for the target, if any. */
export const rateLimitOf = (target: Model.Ref) => limits.get(key(target))?.snapshot

/** Re-applies windows that were still holding targets back when the process last stopped, with the
 * snapshot that produced them, so a cold target still has the provider's last word. */
export const seedLimits = (
  rows: ReadonlyArray<{
    providerID: string
    modelID: string
    until: number
    snapshot?: ModelRouteLimits.Snapshot
  }>,
) => {
  for (const row of rows)
    limits.set(key(ref({ providerID: row.providerID, model: row.modelID })), {
      until: row.until,
      ...(row.snapshot ? { snapshot: row.snapshot } : {}),
    })
}

/** An expiring operator or agent instruction about which targets to use. `match` is a case-insensitive
 * substring of `provider/model`, so "anthropic" or "claude" covers every target that looks like it. */
export interface Adjustment {
  readonly id: string
  readonly match: string
  /** `skip` removes matching targets unless nothing else is available; `weight` scales their share. */
  readonly action: "skip" | "weight"
  readonly factor?: number
  readonly until: number
  readonly note?: string
}

let adjustments: readonly Adjustment[] = []

export const setAdjustments = (next: readonly Adjustment[]) => {
  adjustments = next
}

/** Adds an adjustment, replacing one with the same id, and records it so it survives a restart. */
export const addAdjustment = (item: Adjustment, text?: string) => {
  adjustments = [...adjustments.filter((existing) => existing.id !== item.id), item]
  ModelRouteLog.record({
    kind: "note",
    row: {
      time: Date.now(),
      text: text ?? item.note ?? item.id,
      interpreted: { op: "add", adjustment: item },
      expires: item.until,
    },
  })
}

export const removeAdjustment = (id: string) => {
  const existed = adjustments.some((item) => item.id === id)
  adjustments = adjustments.filter((item) => item.id !== id)
  if (existed)
    ModelRouteLog.record({
      kind: "note",
      row: { time: Date.now(), text: `remove ${id}`, interpreted: { op: "remove", id } },
    })
  return existed
}

/** Re-applies cooldowns that were still running when the process last stopped. */
export const seedCooldowns = (rows: ReadonlyArray<{ providerID: string; modelID: string; until: number }>) => {
  for (const row of rows) entry(ref({ providerID: row.providerID, model: row.modelID })).cooldownUntil = row.until
}

ModelRouteLog.onRestoreCooldowns(seedCooldowns)
ModelRouteLog.onRestoreLimits(seedLimits)
ModelRouteLog.onRestoreUsage(seedUsage)

ModelRouteLog.onRestore((notes) => {
  const restored = new Map<string, Adjustment>()
  for (const note of notes) {
    if (note.op === "add" && note.adjustment)
      restored.set((note.adjustment as Adjustment).id, note.adjustment as Adjustment)
    if (note.op === "remove" && typeof note.id === "string") restored.delete(note.id)
  }
  adjustments = [...restored.values()]
})

export const activeAdjustments = (now = Date.now()) => adjustments.filter((item) => item.until > now)

const matches = (item: Adjustment, target: Model.Ref) =>
  `${target.providerID}/${target.id}`.toLowerCase().includes(item.match.toLowerCase())

const userOverrides = (
  action: ModelRouteOverrides.Action,
  target: Model.Ref,
  now: number,
  scope: ModelRouteOverrides.Scope,
) =>
  ModelRouteOverrides.current().filter(
    (item) => item.action === action && ModelRouteOverrides.applies(item, target, now, scope),
  )

const userOverride = (
  action: ModelRouteOverrides.Action,
  target: Model.Ref,
  now: number,
  scope: ModelRouteOverrides.Scope,
) => userOverrides(action, target, now, scope).length > 0

/** A target the user has said to avoid, on this route. Applies at every autonomy level. */
export const userSkipped = (target: Model.Ref, now = Date.now(), scope: ModelRouteOverrides.Scope = {}) =>
  userOverride("avoid", target, now, scope)

/** A target the route's learned adjustments skip. Only routes that let the tuner decide see these. */
export const skipped = (target: Model.Ref, now = Date.now()) =>
  activeAdjustments(now).some((item) => item.action === "skip" && matches(item, target))

/** Weight multiplier for a target demoted by quota errors. */
const DEMOTED_FACTOR = 0.01

/** How much a user's "prefer" lifts a target when they don't say by how much. */
const PREFERRED_FACTOR = 3

/** The weight a target carries on a route. The user's own priorities apply on every route; learned
 * weights apply only where the tuner is allowed to decide, so a `fixed` route keeps its order. */
export const weightFactor = (target: Model.Ref, now = Date.now(), scope: ModelRouteOverrides.Scope = {}) => {
  const preferred = userOverrides("prefer", target, now, scope).reduce(
    (product, item) => product * (item.factor ?? PREFERRED_FACTOR),
    1,
  )
  const learned =
    scope.fixed === true
      ? 1
      : activeAdjustments(now)
          .filter((item) => item.action === "weight" && matches(item, target))
          .reduce((product, item) => product * (item.factor ?? 1), 1)
  return preferred * learned * (demoted(target, now) ? DEMOTED_FACTOR : 1)
}

/** A session already answered by this target keeps it through a burst rate-limit hold, as long as the
 * target is still working and not demoted. New sessions go elsewhere; current ones stay where their
 * cache is, and only move when the target itself starts failing. */
export const keepsThrough = (routeID: string, sessionID: string | undefined, target: Model.Ref, now = Date.now()) =>
  sessionID !== undefined &&
  continuityOf(routeID, sessionID)?.current === key(target) &&
  steady(target) &&
  !demoted(target, now)

/** The scope overrides and weights are judged against: this route, and whether it is `fixed`. */
export const scopeOf = (definition: Definition): ModelRouteOverrides.Scope => ({
  routeID: definition.id,
  fixed: !ModelRouteAutonomy.usesRules(definition.autonomy),
})

/** Chooses one leaf lazily. Only groups on the chosen path draw their sticky/rotation entry; nested
 * siblings aren't consumed until failover reaches them. This makes RR and weights compositional. */
export const nextTarget = (
  definition: Definition,
  ready: ReadonlySet<number>,
  tried: ReadonlySet<number>,
  sessionID: string | undefined,
  draw: boolean,
  variant?: string,
  unavailable?: ReadonlyMap<number, string>,
  random: () => number = Math.random,
): number | undefined => {
  const hasReady = (nodeIndex: number): boolean => {
    const node = definition.nodes[nodeIndex]
    if (!node) return false
    return node.children.some((child) =>
      child.leaf !== undefined
        ? ready.has(child.leaf) && !tried.has(child.leaf)
        : child.node !== undefined && hasReady(child.node),
    )
  }
  const leaves = (nodeIndex: number): number[] => {
    const node = definition.nodes[nodeIndex]
    if (!node) return []
    return node.children.flatMap((child) =>
      child.leaf !== undefined ? [child.leaf] : child.node !== undefined ? leaves(child.node) : [],
    )
  }
  const factor = (nodeIndex: number) => {
    const eligible = leaves(nodeIndex).filter((index) => ready.has(index) && !tried.has(index))
    return eligible.length === 0
      ? 1
      : eligible.reduce(
          (sum, index) => sum + weightFactor(definition.targets[index], Date.now(), scopeOf(definition)),
          0,
        ) / eligible.length
  }
  const label = (child: Node["children"][number]) =>
    child.leaf !== undefined
      ? `${definition.targets[child.leaf]?.providerID}/${definition.targets[child.leaf]?.id}`
      : child.node !== undefined
        ? `opencode-route/${definition.nodes[child.node]?.routeID ?? child.node}`
        : "unknown"
  const walk = (nodeIndex: number): number | undefined => {
    const node = definition.nodes[nodeIndex]
    if (!node) return undefined
    const positions = node.children.flatMap((child, position) => {
      const available =
        child.leaf !== undefined
          ? ready.has(child.leaf) && !tried.has(child.leaf)
          : child.node !== undefined && hasReady(child.node)
      return available ? [position] : []
    })
    if (positions.length === 0) {
      ModelRouteLog.record({
        kind: "decision",
        row: {
          time: Date.now(),
          session_id: sessionID,
          route_id: node.routeID ?? definition.id,
          selection: node.selection,
          variant,
          candidates: [],
          reason: "no-candidates",
        },
      })
      return undefined
    }
    const factors = node.children.map((child) =>
      child.leaf !== undefined
        ? weightFactor(definition.targets[child.leaf], Date.now(), scopeOf(definition))
        : child.node !== undefined
          ? factor(child.node)
          : 1,
    )
    const selectionKey = `${node.routeID ?? definition.id}#${nodeIndex}`
    const priorSticky = sessionID ? sessionTarget(selectionKey, sessionID) : undefined
    // A session stays on the target it is being answered by while that target is ready, so a recovered
    // primary does not pull it back and throw away the cache it has built on the fallback.
    const current = sessionID ? continuityOf(definition.id, sessionID)?.current : undefined
    const currentPosition =
      current === undefined
        ? undefined
        : positions.find((position) => {
            const leaf = node.children[position].leaf
            if (leaf === undefined) return false
            const target = definition.targets[leaf]
            return key(target) === current && !demoted(target)
          })
    let ordered = positions
    let decisionReason = "ordered"
    if (node.selection === "ordered" && currentPosition !== undefined) {
      ordered = [currentPosition, ...positions.filter((position) => position !== currentPosition)]
      decisionReason = "sticky"
    } else if (node.selection === "ordered" && positions.some((position) => factors[position] !== 1)) {
      ordered = positions.toSorted((left, right) => factors[right] - factors[left])
      decisionReason = "adjusted"
    } else if (sessionID && sessionScoped(node.selection)) {
      const chosen =
        priorSticky !== undefined && positions.includes(priorSticky)
          ? priorSticky
          : draw
            ? selectSessionTarget(
                selectionKey,
                sessionID,
                node.selection,
                positions,
                node.children.map((_, position) => (node.weights[position] ?? 1) * (factors[position] ?? 1)),
                random,
              )
            : undefined
      if (chosen !== undefined) ordered = [chosen, ...positions.filter((position) => position !== chosen)]
      decisionReason =
        priorSticky !== undefined && positions.includes(priorSticky) ? "sticky" : draw ? "drawn" : "ordered"
    }
    const chosen = ordered[0]
    const excluded = node.children.flatMap((child, position) => {
      const childLeaves = child.leaf !== undefined ? [child.leaf] : child.node !== undefined ? leaves(child.node) : []
      return childLeaves.flatMap((index) => {
        const unavailableReason = unavailable?.get(index) ?? (tried.has(index) ? "already-tried" : undefined)
        return unavailableReason ? [{ candidate: label(node.children[position]), reason: unavailableReason }] : []
      })
    })
    ModelRouteLog.record({
      kind: "decision",
      row: {
        time: Date.now(),
        session_id: sessionID,
        route_id: node.routeID ?? definition.id,
        selection: node.selection,
        variant,
        candidates: positions.map((position) => label(node.children[position])),
        chosen: chosen === undefined ? undefined : label(node.children[chosen]),
        reason: decisionReason,
        detail: {
          weights: Object.fromEntries(
            positions.map((position) => [label(node.children[position]), node.weights[position] * factors[position]]),
          ),
          excluded,
        },
      },
    })
    const selected = chosen === undefined ? undefined : node.children[chosen]
    if (!selected) return undefined
    if (selected.leaf !== undefined) return selected.leaf
    return selected.node === undefined ? undefined : walk(selected.node)
  }
  return walk(0)
}

/** Compatibility/test helper. Production resolution calls `nextTarget` lazily so unvisited sibling
 * groups do not consume their own round-robin or weighted draw. */
export const orderTargets = (
  definition: Definition,
  ready: ReadonlySet<number>,
  sessionID: string | undefined,
  draw: boolean,
) => {
  const tried = new Set<number>()
  const result: number[] = []
  while (true) {
    const next = nextTarget(definition, ready, tried, sessionID, draw)
    if (next === undefined) return result
    tried.add(next)
    result.push(next)
  }
}

/** Drops a session's sticky choice, e.g. when its model selection leaves the route. Test seam. */
export const forgetSession = (routeID: string, sessionID: string) => {
  selection.get(routeID)?.sessions.delete(sessionID)
}

export const resetSelection = () => selection.clear()

/** Where a session has been answered on a route. `origin` is the target it moved away from after a
 * failover; `away` counts requests answered since on the target it moved to. */
export interface Continuity {
  readonly current: string
  readonly origin?: string
  readonly away: number
}

/** A session that just failed over may hedge back to its origin for this many requests. */
export const ORIGIN_HEDGE_REQUESTS = 2
const CONTINUITY_LIMIT = 5_000
const continuity = new Map<string, Continuity>()

const continuityKey = (routeID: string, sessionID: string) => `${routeID}\u0000${sessionID}`

export const continuityOf = (routeID: string, sessionID: string) => continuity.get(continuityKey(routeID, sessionID))

const remember = (id: string, next: Continuity) => {
  continuity.delete(id)
  continuity.set(id, next)
  while (continuity.size > CONTINUITY_LIMIT) continuity.delete(continuity.keys().next().value!)
}

/** A request on this route failed over from `from`. The first move keeps `from` as the origin; later
 * moves keep the original origin, so a session drifting between fallbacks still returns home. */
export const moved = (routeID: string, sessionID: string, from: Model.Ref) => {
  const id = continuityKey(routeID, sessionID)
  const prior = continuity.get(id)
  remember(id, { current: key(from), origin: prior?.origin ?? key(from), away: 0 })
}

/** A request on this route was answered by `target`. Answering from the origin ends the move. */
export const served = (routeID: string, sessionID: string, target: Model.Ref) => {
  const id = continuityKey(routeID, sessionID)
  const current = key(target)
  const prior = continuity.get(id)
  if (prior?.origin === undefined || prior.origin === current) return remember(id, { current, away: 0 })
  remember(id, { current, origin: prior.origin, away: Math.min(prior.away + 1, ORIGIN_HEDGE_REQUESTS) })
}

/** The origin a session should hedge back to: only just after it moved, and never once it has
 * settled on the new target. */
export const hedgeHome = (routeID: string, sessionID: string) => {
  const state = continuityOf(routeID, sessionID)
  if (state?.origin === undefined || state.away >= ORIGIN_HEDGE_REQUESTS) return undefined
  return state.origin
}
