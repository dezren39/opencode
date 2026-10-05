export * as ConfigModelRoutesPlugin from "./model-routes.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Document, type Entry } from "@opencode/schema/config"
import { ConfigModel } from "@opencode/schema/config/model"
import { ConfigModelRoutes } from "@opencode/schema/config/model-routes"
import { Effect } from "effect"
import { Config } from "../../config.js"
import { Model } from "../../model.js"
import { ModelRoute } from "../../model-route.js"
import { Provider } from "../../provider.js"
import { ConfigEntryObserver } from "./entry-observer.js"

type SourceModel = {
  readonly ref: Model.Ref
  readonly model: Model.Info
  readonly fixedVariant: boolean
}

export const Plugin = define({
  id: "opencode.config.model-routes",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.provider.reload())

    yield* ctx.provider.transform((providers) => {
      if (providers.get(ModelRoute.PROVIDER_ID)) return
      const routes = configuredRoutes(loaded.entries)
      if (routes.size === 0) return
      const definitions = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>(
        providers.list().map((record) => [record.provider.id, record.models] as const),
      )
      const models = Array.from(routes, ([id, route]) => {
        const expanded = expand(id, routes, definitions)
        if (expanded.length === 0) return undefined
        const first = expanded[0].model
        const health = ModelRoute.policy(route.health)
        const info = Model.Info.make({
          ...Model.Info.default(ModelRoute.PROVIDER_ID, Model.ID.make(id)),
          name: route.name?.trim() || id,
          settings: {
            [ModelRoute.SETTING]: {
              id: Model.ID.make(id),
              targets: expanded.map((target) => target.ref),
              health,
            },
          },
          capabilities: {
            tools: expanded.every((target) => target.model.capabilities.tools),
            input: intersect(expanded.map((target) => target.model.capabilities.input)),
            output: intersect(expanded.map((target) => target.model.capabilities.output)),
          },
          variants: routeVariants(expanded),
          cost: first.cost,
          status: "active",
          limit: {
            context: Math.min(...expanded.map((target) => target.model.limit.context)),
            output: Math.min(...expanded.map((target) => target.model.limit.output)),
            ...(expanded.every((target) => target.model.limit.input !== undefined)
              ? { input: Math.min(...expanded.map((target) => target.model.limit.input!)) }
              : {}),
          },
        })
        return info
      }).filter((model): model is Model.Info => model !== undefined)

      if (models.length === 0) return
      providers.add({
        info: {
          ...Provider.Info.empty(ModelRoute.PROVIDER_ID),
          name: "OpenCode routes",
          activation: "enabled",
        },
        models,
      })
    })
  }),
})

function configuredRoutes(entries: readonly Entry[]) {
  const routes = new Map<string, ConfigModelRoutes.Route>()
  entries
    .filter((entry): entry is Document => entry.type === "document")
    .forEach((entry) => {
      Object.entries(entry.info.experimental?.model_routes ?? {}).forEach(([id, route]) => routes.set(id, route))
    })
  return routes
}

function expand(
  id: string,
  routes: ReadonlyMap<string, ConfigModelRoutes.Route>,
  definitions: ReadonlyMap<Provider.ID, ReadonlyMap<string, Model.Info>>,
) {
  const result: SourceModel[] = []
  const seen = new Set<string>()

  const visit = (routeID: string, inheritedVariant: Model.VariantID | undefined, trail: ReadonlySet<string>) => {
    if (trail.has(routeID)) return
    const current = routes.get(routeID)
    if (!current) return
    const nextTrail = new Set(trail).add(routeID)
    for (const target of current.targets) {
      const ref = targetRef(target)
      if (ref.providerID === ModelRoute.PROVIDER_ID) {
        if (ref.variant) {
          visit(ref.id, ref.variant, nextTrail)
          continue
        }
        visit(ref.id, inheritedVariant, nextTrail)
        continue
      }
      const model = definitions.get(ref.providerID)?.get(ref.id)
      if (!model || !model.enabled) continue
      const variant = ref.variant ?? inheritedVariant
      if (variant && !model.variants.some((item) => item.id === variant)) continue
      const resolved = Model.Ref.make({
        providerID: ref.providerID,
        id: ref.id,
        ...(variant ? { variant } : {}),
      })
      const key = `${resolved.providerID}/${resolved.id}${resolved.variant ? `#${resolved.variant}` : ""}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push({ ref: resolved, model, fixedVariant: ref.variant !== undefined || inheritedVariant !== undefined })
    }
  }

  visit(id, undefined, new Set())
  return result
}

function targetRef(target: ConfigModel.Selection): Model.Ref {
  return Model.Ref.make({
    providerID: Provider.ID.make(target.providerID),
    id: Model.ID.make(target.model),
    ...(target.variant ? { variant: Model.VariantID.make(target.variant) } : {}),
  })
}

function intersect(values: readonly (readonly string[])[]) {
  const [first, ...rest] = values
  return (first ?? []).filter((value) => rest.every((items) => items.includes(value)))
}

function routeVariants(targets: readonly SourceModel[]) {
  if (targets.some((target) => target.fixedVariant)) return []
  return intersect(targets.map((target) => target.model.variants.map((variant) => variant.id))).map((id) => ({
    id: Model.VariantID.make(id),
  }))
}
