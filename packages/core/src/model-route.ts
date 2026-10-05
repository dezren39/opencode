export * as ModelRoute from "./model-route.js"

import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Schema } from "effect"
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

const Definition = Schema.Struct({
  id: Model.ID,
  targets: Schema.Array(Model.Ref),
  health: Policy,
})

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

const recover = (state: { samples: boolean[]; cooldownUntil: number }, now: number) => {
  if (state.cooldownUntil === 0 || state.cooldownUntil > now) return
  state.cooldownUntil = 0
  state.samples = []
}

export const coolingDown = (target: Model.Ref, now = Date.now()) => {
  const state = health.get(key(target))
  if (!state) return false
  recover(state, now)
  return state.cooldownUntil > now
}

export const cooldownUntil = (target: Model.Ref, now = Date.now()) => {
  const state = health.get(key(target))
  if (!state) return 0
  recover(state, now)
  return state.cooldownUntil
}

export const failed = (target: Model.Ref, policy: Policy, now = Date.now()) => {
  const state = entry(target)
  state.samples = []
  state.cooldownUntil = now + policy.cooldownMs
}

export const completed = (
  target: Model.Ref,
  policy: Policy,
  sample: { readonly firstTokenMs: number; readonly responseMs: number; readonly tokensPerSecond: number },
  now = Date.now(),
) => {
  const state = entry(target)
  recover(state, now)
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
  }
}

/** Test seam; health is intentionally process-local and never persists prompts or request contents. */
export const resetHealth = () => health.clear()
