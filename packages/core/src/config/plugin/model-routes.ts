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
import { Permission } from "../../permission.js"
import { RouteAdjustTool } from "../../tool/plugin/route-adjust.js"
import { RouteStatsTool } from "../../tool/plugin/route-stats.js"

type SourceModel = {
  readonly ref: Model.Ref
  readonly model: Model.Info
  readonly fixedVariant: boolean
  /** Variant used when the route is selected without an explicit one. */
  readonly defaultVariant?: Model.VariantID
  /** Route-level variant → this target's variant. */
  readonly budget?: ModelRoute.Budget
  readonly variantMap?: Readonly<Record<string, Model.VariantID>>
}

export const Plugin = define({
  id: "opencode.config.model-routes",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const loaded = yield* ConfigEntryObserver.observe(
      config,
      ctx.event,
      ctx.provider.reload().pipe(Effect.andThen(ctx.tool.reload())),
    )

    yield* ctx.tool.transform((editor) => {
      if (configuredRoutes(loaded.entries).size === 0) return
      RouteAdjustTool.add(editor, permission)
      RouteStatsTool.add(editor, permission)
    })

    yield* ctx.provider.transform((providers) => {
      if (providers.get(ModelRoute.PROVIDER_ID)) return
      const routes = configuredRoutes(loaded.entries)
      if (routes.size === 0) return
      const definitions = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>(
        providers.list().map((record) => [record.provider.id, record.models] as const),
      )
      const models = Array.from(routes, ([id, route]) => {
        const { leaves: expanded, nodes } = expand(id, routes, definitions)
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
              targetVariants: expanded.map((target) => ({
                ...(target.defaultVariant ? { default: target.defaultVariant } : {}),
                ...(target.variantMap ? { map: target.variantMap } : {}),
              })),
              health,
              nodes,
              attempts: route.attempts ?? 1,
              budgets: expanded.map((target) => target.budget ?? {}),
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
  const nodes: ModelRoute.Node[] = []
  const seen = new Set<string>()

  // Each route becomes a group node with its own selection mode and weights, so a weighted route
  // nested in another is chosen as one unit and then splits among its own members.
  const visit = (
    routeID: string,
    inheritedVariant: Model.VariantID | undefined,
    trail: ReadonlySet<string>,
  ): number | undefined => {
    if (trail.has(routeID)) return
    const current = routes.get(routeID)
    if (!current) return
    const nextTrail = new Set(trail).add(routeID)
    const nodeIndex = nodes.length
    const node: {
      selection: ModelRoute.Node["selection"]
      weights: number[]
      children: ModelRoute.Node["children"][number][]
    } = {
      selection: current.selection ?? "ordered",
      weights: [],
      children: [],
    }
    nodes.push(node)
    const attach = (child: ModelRoute.Node["children"][number], key: string) => {
      node.children.push(child)
      node.weights.push(current.weights?.[key] ?? 1)
    }
    for (const target of current.targets) {
      const spec = targetSpec(target)
      const ref = targetRef(spec.model)
      if (ref.providerID === ModelRoute.PROVIDER_ID) {
        const child = visit(ref.id, ref.variant ?? inheritedVariant, nextTrail)
        if (child !== undefined) attach({ node: child }, `${ModelRoute.PROVIDER_ID}/${ref.id}`)
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
      const defaultVariant =
        spec.defaultVariant && model.variants.some((item) => item.id === spec.defaultVariant)
          ? Model.VariantID.make(spec.defaultVariant)
          : undefined
      const variantMap = Object.fromEntries(
        Object.entries(spec.variants ?? {}).flatMap(([from, to]) =>
          model.variants.some((item) => item.id === to) ? [[from, Model.VariantID.make(to)] as const] : [],
        ),
      )
      const leafKey = `${resolved.providerID}/${resolved.id}`
      attach({ leaf: result.length }, leafKey)
      // Budgets belong to the target: the outermost route that declares one wins, wherever the
      // target was first reached.
      const budget = plainBudget(
        [...nextTrail].map((id) => routes.get(id)?.budgets?.[leafKey]).find((value) => value !== undefined),
      )
      result.push({
        ...(budget ? { budget } : {}),
        ref: resolved,
        model,
        fixedVariant: ref.variant !== undefined || inheritedVariant !== undefined,
        ...(defaultVariant ? { defaultVariant } : {}),
        ...(Object.keys(variantMap).length ? { variantMap } : {}),
      })
    }
    return node.children.length > 0 ? nodeIndex : undefined
  }

  visit(id, undefined, new Set())
  return { leaves: result, nodes }
}

/** Settings are stored as JSON, which has no undefined: keep only the allowances actually set. */
function plainBudget(budget: ConfigModelRoutes.Budget | undefined): ModelRoute.Budget | undefined {
  if (!budget) return undefined
  const entries = Object.entries(budget).filter(([, value]) => typeof value === "number")
  return entries.length > 0 ? (Object.fromEntries(entries) as ModelRoute.Budget) : undefined
}

function targetSpec(target: ConfigModelRoutes.Target) {
  return typeof target === "string" || "providerID" in target ? { model: target } : target
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
  // A route-level variant is offered when every target can produce it, either natively or through
  // its remap table.
  return intersect(
    targets.map((target) => {
      const native = target.model.variants.map((variant) => variant.id)
      const remapped = Object.keys(target.variantMap ?? {})
      return [...new Set([...native, ...remapped])]
    }),
  ).map((id) => ({ id: Model.VariantID.make(id) }))
}
