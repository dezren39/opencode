export * as ModelRoute from "./model-route.js"

import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Schema } from "effect"
import { ModelRouteLog } from "./model-route-log.js"
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
})

const TargetVariant = Schema.Struct({
  default: Model.VariantID.pipe(optional),
  map: Schema.Record(Schema.String, Model.VariantID).pipe(optional),
})

const Mode = Schema.Literals(["ordered", "round-robin", "weighted"])

/** A group of targets with its own selection mode. Children are leaf target indexes or nested
 * groups; `weights` is parallel to `children`. Group 0 is the route itself. */
const Node = Schema.Struct({
  selection: Mode,
  weights: Schema.Array(Schema.Finite.check(Schema.isGreaterThan(0))),
  children: Schema.Array(Schema.Struct({ leaf: Schema.Finite.pipe(optional), node: Schema.Finite.pipe(optional) })),
})

const Definition = Schema.Struct({
  id: Model.ID,
  targets: Schema.Array(Model.Ref),
  targetVariants: Schema.Array(TargetVariant),
  health: Policy,
  nodes: Schema.Array(Node),
})

export type Node = typeof Node.Type
export type Policy = typeof Policy.Type
export type Definition = typeof Definition.Type

const DEFAULT_POLICY: Policy = {
  firstTokenTimeoutMs: 10_000,
  sampleWindow: 5,
  slowThreshold: 3,
  cooldownMs: 60_000,
}

export const policy = (input?: {
  readonly firstTokenTimeoutMs?: number | false
  readonly maxResponseTimeMs?: number
  readonly minOutputTokensPerSecond?: number
  readonly sampleWindow?: number
  readonly slowThreshold?: number
  readonly cooldownMs?: number
}): Policy => {
  const sampleWindow = Math.min(input?.sampleWindow ?? DEFAULT_POLICY.sampleWindow, 50)
  return {
    firstTokenTimeoutMs: input?.firstTokenTimeoutMs ?? DEFAULT_POLICY.firstTokenTimeoutMs,
    maxResponseTimeMs: input?.maxResponseTimeMs,
    minOutputTokensPerSecond: input?.minOutputTokensPerSecond,
    sampleWindow,
    slowThreshold: Math.min(input?.slowThreshold ?? DEFAULT_POLICY.slowThreshold, sampleWindow),
    cooldownMs: Math.min(input?.cooldownMs ?? DEFAULT_POLICY.cooldownMs, 3_600_000),
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

const health = new Map<string, { samples: boolean[]; cooldownUntil: number }>()
const HEALTH_LIMIT = 2_000

const key = (target: Model.Ref) => `${target.providerID}/${target.id}`

const entry = (target: Model.Ref) => {
  const id = key(target)
  const current = health.get(id) ?? { samples: [], cooldownUntil: 0 }
  health.delete(id)
  health.set(id, current)
  while (health.size > HEALTH_LIMIT) health.delete(health.keys().next().value!)
  return current
}

const logHealth = (target: Model.Ref, kind: "cooldown-start" | "cooldown-end", reason: string, until?: number) =>
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

export const coolingDown = (target: Model.Ref, now = Date.now()) => {
  const state = health.get(key(target))
  if (!state) return false
  recover(target, state, now)
  return state.cooldownUntil > now
}

export const cooldownUntil = (target: Model.Ref, now = Date.now()) => {
  const state = health.get(key(target))
  if (!state) return 0
  recover(target, state, now)
  return state.cooldownUntil
}

export const failed = (target: Model.Ref, policy: Policy, now = Date.now()) => {
  const state = entry(target)
  state.samples = []
  state.cooldownUntil = now + policy.cooldownMs
  logHealth(target, "cooldown-start", "failure", state.cooldownUntil)
}

export const completed = (
  target: Model.Ref,
  policy: Policy,
  sample: { readonly firstTokenMs: number; readonly responseMs: number; readonly tokensPerSecond: number },
  now = Date.now(),
) => {
  const state = entry(target)
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
export const resetHealth = () => health.clear()

/** Per-route selection state: rotation counters for round-robin, sticky session choices, both
 * process-local like health. */
const selection = new Map<string, { cursor: number; sessions: Map<string, number> }>()
const SESSION_LIMIT = 5_000

const selectionEntry = (routeID: string) => {
  let current = selection.get(routeID)
  if (!current) {
    current = { cursor: 0, sessions: new Map() }
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
): number | undefined => {
  if (candidateIndexes.length === 0) return undefined
  const first = candidateIndexes[0]
  if (mode === "ordered" || candidateIndexes.length === 1) return first
  const state = selectionEntry(routeID)
  const sticky = state.sessions.get(sessionID)
  if (sticky !== undefined && candidateIndexes.includes(sticky)) return sticky
  let chosen: number
  if (mode === "round-robin") {
    const positions = candidateIndexes.map((index, position) => [position, index] as const)
    const at = state.cursor % candidateIndexes.length
    chosen = positions[at][1]
    state.cursor = (state.cursor + 1) % Number.MAX_SAFE_INTEGER
  } else {
    const total = candidateIndexes.reduce((sum, index) => sum + (weights[index] ?? 1), 0)
    let draw = Math.random() * total
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

/** Walks the group tree into an ordered list of leaf target indexes. Each group puts its chosen
 * child first (sticky per session, drawn only when `draw` is set) and keeps the rest in config
 * order, so failover walks siblings before leaving the group's parent. Groups with no ready leaf
 * drop out and their weight is redistributed. */
export const orderTargets = (
  definition: Definition,
  ready: ReadonlySet<number>,
  sessionID: string | undefined,
  draw: boolean,
): number[] => {
  const walk = (nodeIndex: number): number[][] => {
    const node = definition.nodes[nodeIndex]
    if (!node) return []
    const groups = node.children.map((child) =>
      child.leaf !== undefined
        ? ready.has(child.leaf)
          ? [child.leaf]
          : []
        : child.node !== undefined
          ? walk(child.node).flat()
          : [],
    )
    const positions = groups.flatMap((group, position) => (group.length > 0 ? [position] : []))
    let ordered = positions
    if (sessionID && sessionScoped(node.selection) && positions.length > 1) {
      const key = `${definition.id}#${nodeIndex}`
      const sticky = sessionTarget(key, sessionID)
      const chosen =
        sticky !== undefined && positions.includes(sticky)
          ? sticky
          : draw
            ? selectSessionTarget(key, sessionID, node.selection, positions, node.weights)
            : undefined
      if (chosen !== undefined) ordered = [chosen, ...positions.filter((position) => position !== chosen)]
    }
    return ordered.map((position) => groups[position])
  }
  return walk(0).flat()
}

/** Drops a session's sticky choice, e.g. when its model selection leaves the route. Test seam. */
export const forgetSession = (routeID: string, sessionID: string) => {
  selection.get(routeID)?.sessions.delete(sessionID)
}

export const resetSelection = () => selection.clear()
