export * as ModelResolver from "./model-resolver.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { HttpOptions, LanguageModel, mergeHttpOptions, ProviderConfigurationError } from "@opencode/ai"
import { Auth } from "@opencode/ai/route"
import { Context, Effect, Layer, Result, Schema, Struct } from "effect"
import { AISDK } from "./aisdk.js"
import { Credential } from "./credential.js"
import { Integration } from "./integration.js"
import { Capabilities, ID, Info, Model, Ref, VariantID } from "./model.js"
import type { RuntimeInfo } from "./model.js"
import { Npm } from "@opencode/util/npm"
import { Provider } from "./provider.js"
import { ModelRoute } from "./model-route.js"

export class VariantUnavailableError extends Schema.TaggedError<VariantUnavailableError>()(
  "SessionRunnerModel.VariantUnavailableError",
  {
    providerID: Provider.ID,
    modelID: ID,
    variant: VariantID,
  },
) {
  override get message() {
    return `Variant unavailable for ${this.providerID}/${this.modelID}: ${this.variant}`
  }
}

export class UnsupportedPackageError extends Schema.TaggedError<UnsupportedPackageError>()(
  "SessionRunnerModel.UnsupportedPackageError",
  {
    providerID: Provider.ID,
    modelID: ID,
    package: Schema.String,
  },
) {
  override get message() {
    return `Unsupported package for ${this.providerID}/${this.modelID}: ${this.package}`
  }
}

export const InitializationPhase = Schema.Literals(["load", "init", "construct"])
export type InitializationPhase = typeof InitializationPhase.Type

/** Provider settings are missing, conflicting, or unsupported; the provider's own message tells the user what to fix. */
export class ModelConfigurationError extends Schema.TaggedError<ModelConfigurationError>()(
  "SessionRunnerModel.ModelConfigurationError",
  {
    providerID: Provider.ID,
    modelID: ID,
    package: Schema.String,
    detail: Schema.String,
  },
) {
  override get message() {
    return `Cannot initialize ${this.providerID}/${this.modelID}: ${this.detail}`
  }
}

/** A supported package failed unexpectedly while loading or constructing the model. */
export class ModelInitializationError extends Schema.TaggedError<ModelInitializationError>()(
  "SessionRunnerModel.ModelInitializationError",
  {
    providerID: Provider.ID,
    modelID: ID,
    package: Schema.String,
    phase: InitializationPhase,
    detail: Schema.String,
  },
) {
  override get message() {
    return `Cannot initialize ${this.providerID}/${this.modelID}: ${this.detail}`
  }
}

export class UnresolvedProviderVariablesError extends Schema.TaggedError<UnresolvedProviderVariablesError>()(
  "SessionRunnerModel.UnresolvedProviderVariablesError",
  {
    providerID: Provider.ID,
    modelID: ID,
    variables: Schema.Array(Schema.String),
  },
) {
  override get message() {
    return `Cannot initialize ${this.providerID}/${this.modelID}: ${this.variables.join(", ")} ${this.variables.length === 1 ? "is" : "are"} required to resolve the provider endpoint`
  }
}

export class UnsupportedCompactionError extends Schema.TaggedError<UnsupportedCompactionError>()(
  "SessionRunnerModel.UnsupportedCompactionError",
  {
    providerID: Provider.ID,
    modelID: ID,
    route: Schema.String,
  },
) {
  override get message() {
    return `Provider compaction is not supported by ${this.providerID}/${this.modelID} (${this.route})`
  }
}

export class RouteUnavailableError extends Schema.TaggedError<RouteUnavailableError>()(
  "SessionRunnerModel.RouteUnavailableError",
  { routeID: ID },
) {
  override get message() {
    return `No model is available for route ${ModelRoute.PROVIDER_ID}/${this.routeID}`
  }
}

export type Error =
  | VariantUnavailableError
  | UnsupportedPackageError
  | ModelConfigurationError
  | ModelInitializationError
  | UnresolvedProviderVariablesError
  | UnsupportedCompactionError
  | RouteUnavailableError
  | Integration.AuthorizationError

export interface Resolved {
  /** Route-level model for provider requests; its id is the provider API model id, which may differ from the catalog id. */
  readonly model: LanguageModel
  /** Selected catalog identity. Durable records and displays must use this, never the API model id. */
  readonly ref: Ref
  /** Catalog capabilities used to shape requests before provider lowering. */
  readonly capabilities: Capabilities
  /** Catalog pricing in dollars per million tokens. */
  readonly cost: Info["cost"]
  /** Catalog token limits used by Core for context management. */
  readonly limit: Info["limit"]
  /** Model policy overrides the provider policy; omitted means summary compaction. */
  readonly compaction?: Provider.Compaction
  /** Provider transport policy; omitted means HTTP. */
  readonly transport?: Provider.Transport
  /** Milliseconds without streamed data before a WebSocket exchange fails; `false` disables the limit. */
  readonly chunkTimeout?: number | false
  /** Selection and health data for a configured OpenCode model route. */
  readonly routing?: {
    readonly routeID: ID
    readonly target: Ref
    readonly policy: ModelRoute.Policy
    readonly fallback: () => Effect.Effect<Resolved | undefined, Error>
  }
}

export interface Interface {
  readonly resolve: (requested?: Ref) => Effect.Effect<Resolved | undefined, Error>
  /** `sessionID` enables per-session target stickiness for routes with a non-ordered selection mode. */
  readonly resolveModel: (model: Info, variant?: VariantID, sessionID?: string) => Effect.Effect<Resolved, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ModelResolver") {}

// Variant resolution adds request-local overlays without changing the committed model snapshot.
export const withVariant = (
  model: Info,
  variantID: VariantID | undefined,
): Effect.Effect<Info, VariantUnavailableError> => {
  const id = variantID === "default" ? undefined : variantID
  const variant = model.variants?.find((item) => item.id === id)
  if (!variant && id !== undefined)
    return Effect.fail(
      new VariantUnavailableError({
        providerID: model.providerID,
        modelID: model.id,
        variant: id,
      }),
    )
  return Effect.succeed(
    variant
      ? {
          ...model,
          settings: Provider.mergeOverlay(model.settings, Provider.modelSettings(variant.settings)),
          headers: Provider.mergeHeaders(model.headers, variant.headers),
          body: Provider.mergeOverlay(model.body, variant.body),
        }
      : model,
  )
}

export interface Dependencies {
  readonly loadPackage?: (specifier: string) => Effect.Effect<Provider.ProviderPackage, Provider.LoadError>
  readonly loadAISDK?: (model: RuntimeInfo) => Effect.Effect<LanguageModel, AISDK.InitError>
}

export const fromCatalogModel = (
  model: RuntimeInfo,
  credential?: Credential.Value,
  dependencies?: Dependencies,
): Effect.Effect<
  LanguageModel,
  | UnsupportedPackageError
  | ModelConfigurationError
  | ModelInitializationError
  | UnresolvedProviderVariablesError
  | UnsupportedCompactionError
> =>
  resolveCatalogModel(model, credential, dependencies).pipe(
    Effect.flatMap((resolved) => validateProviderVariables(model, resolved)),
    Effect.flatMap((resolved) => {
      // Reject provider compaction policies up front so the misconfiguration surfaces before any step runs.
      if (
        model.settings?.compaction?.type !== "native" ||
        resolved.route.compact?.trigger ||
        resolved.route.compact?.endpoint
      )
        return Effect.succeed(resolved)
      return Effect.fail(
        new UnsupportedCompactionError({ providerID: model.providerID, modelID: model.id, route: resolved.route.id }),
      )
    }),
  )

const resolveCatalogModel = Effect.fn("ModelResolver.resolveCatalogModel")(function* (
  model: RuntimeInfo,
  credential?: Credential.Value,
  dependencies?: Dependencies,
) {
  const resolved = prepareRuntimeModel(model, credential)
  const configuration = credential?.type === "key" ? credential.configuration : undefined
  const configured = { ...resolved.settings, ...credential?.metadata, ...configuration }
  if (Provider.isAISDK(resolved.package)) {
    const loadAISDK = dependencies?.loadAISDK
    if (!loadAISDK) return yield* unsupported(resolved)
    const settings = yield* prepareProviderSettings(
      resolved,
      Provider.mergeOverlay(resolved.settings, {
        ...nativeCredentialSettings(resolved.package ?? "", credential),
        ...credential?.metadata,
        ...configuration,
      }) ?? {},
    )
    return yield* loadAISDK({ ...resolved, settings }).pipe(
      Effect.mapError((error) => initialization(resolved, "init", error.cause)),
    )
  }
  const specifier = Provider.packageName(resolved.package)
  if (!specifier) return yield* unsupported(resolved)
  const mapped = yield* prepareProviderSettings(resolved, Provider.nativeSettings(configured))
  const module = yield* (dependencies?.loadPackage ?? Provider.loadPackage)(specifier).pipe(
    Effect.mapError((error) => initialization(resolved, "load", error.cause)),
  )
  const settings = {
    ...(credential ? Struct.omit(mapped, ["accessToken", "apiKey", "authToken"]) : mapped),
    ...(resolved.canonical === undefined ? {} : { provider: resolved.canonical }),
    ...nativeCredentialSettings(specifier, credential),
    headers: resolved.headers,
    body: resolved.body,
  }
  return yield* Effect.try({
    try: () => {
      const runtime = module.model(resolved.modelID ?? resolved.id, settings)
      return LanguageModel.update(runtime, {
        provider: resolved.canonical ?? resolved.providerID,
        compatibility: resolved.compatibility
          ? Object.assign({}, runtime.compatibility, resolved.compatibility)
          : runtime.compatibility,
        // Timeouts are transport policy, so they land on the route's HTTP defaults instead of package settings.
        defaults: {
          ...runtime.defaults,
          http: mergeHttpOptions(runtime.defaults?.http, new HttpOptions(Provider.timeouts(configured))),
        },
      })
    },
    catch: (cause) =>
      cause instanceof ProviderConfigurationError
        ? new ModelConfigurationError({
            providerID: resolved.providerID,
            modelID: resolved.id,
            package: resolved.package ?? "unknown",
            detail: cause.message,
          })
        : initialization(resolved, "construct", cause),
  })
})

function prepareRuntimeModel(model: RuntimeInfo, credential: Credential.Value | undefined) {
  if (model.settings?.apiKey !== "" && (credential?.type !== "key" || credential.metadata === undefined)) return model
  return {
    ...model,
    ...(model.settings?.apiKey === "" ? { settings: Struct.omit(model.settings, ["apiKey"]) } : {}),
    ...(credential?.type === "key" && credential.metadata !== undefined
      ? { body: Provider.mergeOverlay(model.body, credential.metadata) }
      : {}),
  }
}

function validateProviderVariables(
  model: RuntimeInfo,
  resolved: LanguageModel,
): Effect.Effect<LanguageModel, UnresolvedProviderVariablesError> {
  const baseURL = resolved.route.endpoint.baseURL
  if (typeof baseURL !== "string") return Effect.succeed(resolved)
  const failure = unresolvedProviderVariables(model, baseURL)
  return failure ? Effect.fail(failure) : Effect.succeed(resolved)
}

function prepareProviderSettings(
  model: RuntimeInfo,
  settings: Readonly<Record<string, unknown>>,
): Effect.Effect<Readonly<Record<string, unknown>>, UnresolvedProviderVariablesError> {
  const baseURL = settings.baseURL
  if (typeof baseURL !== "string") return Effect.succeed(settings)
  return prepareProviderURL(model, baseURL).pipe(
    Effect.map((prepared) => (prepared === baseURL ? settings : { ...settings, baseURL: prepared })),
  )
}

function prepareProviderURL(
  model: RuntimeInfo,
  baseURL: string,
): Effect.Effect<string, UnresolvedProviderVariablesError> {
  if (!baseURL.includes("${")) return Effect.succeed(baseURL)
  const prepared = baseURL.replace(/\$\{([^}]+)\}/g, (placeholder, name: string) => process.env[name] ?? placeholder)
  const failure = unresolvedProviderVariables(model, prepared)
  return failure ? Effect.fail(failure) : Effect.succeed(prepared)
}

function unresolvedProviderVariables(model: RuntimeInfo, baseURL: string) {
  const variables = new Set(Array.from(baseURL.matchAll(/\$\{([^}]+)\}/g), (match) => match[1]))
  if (variables.size === 0) return
  return new UnresolvedProviderVariablesError({
    providerID: model.providerID,
    modelID: model.id,
    variables: Array.from(variables),
  })
}

const nativeCredentialSettings = (specifier: string, credential: Credential.Value | undefined) => {
  if (!credential) return {}
  if (credential.type === "key") return { apiKey: credential.key }
  if (specifier === "@opencode/ai/providers/anthropic" || specifier === "@opencode/ai/providers/anthropic-compatible")
    return { authToken: credential.access }
  if (
    specifier === "@opencode/ai/providers/google-vertex" ||
    specifier.startsWith("@opencode/ai/providers/google-vertex/")
  )
    return { accessToken: credential.access }
  return { apiKey: credential.access }
}

const unsupported = (model: RuntimeInfo) =>
  new UnsupportedPackageError({
    providerID: model.providerID,
    modelID: model.id,
    package: model.package ?? "unknown",
  })

const initialization = (model: RuntimeInfo, phase: InitializationPhase, cause: unknown) =>
  new ModelInitializationError({
    providerID: model.providerID,
    modelID: model.id,
    package: model.package ?? "unknown",
    phase,
    detail: causeMessage(cause) ?? `${phase} failed for ${model.package ?? "unknown"}`,
  })

// Unexpected throws still carry the most useful diagnosis in their message; a stack or an unknown value does not.
const causeMessage = (cause: unknown): string | undefined => {
  if (typeof cause === "string") return cause.trim() || undefined
  if (!(cause instanceof globalThis.Error)) return undefined
  const message = cause.message.trim()
  if (message) return message
  return causeMessage(cause.cause)
}

export const resolveModel = (
  model: Info,
  variant: VariantID | undefined,
  credential?: Credential.Value,
  dependencies?: Dependencies,
) => withVariant(model, variant).pipe(Effect.flatMap((model) => fromCatalogModel(model, credential, dependencies)))

export const hasPackage = (model: Info) => Boolean(model.package) || ModelRoute.definition(model) !== undefined

/** Resolves catalog selections into runtime models for the current Location. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const providers = yield* Provider.Service
    const models = yield* Model.Service
    const integrations = yield* Integration.Service
    const npm = yield* Npm.Service
    const aisdk = yield* AISDK.Service
    const load = Effect.fn("ModelResolver.resolveModel")(function* (selected: Info, variant?: VariantID) {
      const provider = yield* providers.get(selected.providerID)
      const connection = yield* integrations.connection.active(
        provider?.integrationID ?? Integration.ID.make(selected.providerID),
      )
      const credential = connection ? yield* integrations.connection.resolve(connection) : undefined
      const selectedVariant = yield* withVariant(selected, variant)
      const runtimeInfo: RuntimeInfo = {
        ...selectedVariant,
        settings: Provider.mergeOverlay(provider?.settings, Provider.modelSettings(selectedVariant.settings)),
      }
      const model = yield* fromCatalogModel(runtimeInfo, credential, {
        loadPackage: (specifier) => Provider.loadPackage(specifier, npm),
        loadAISDK: (model) => aisdk.model(model),
      })
      const runtime =
        provider?.activation === "enabled" &&
        credential === undefined &&
        !hasConfiguredAuth(runtimeInfo) &&
        usesAPIKeyAuth(runtimeInfo.package)
          ? LanguageModel.update(model, { route: model.route.with({ auth: Auth.none }) })
          : model
      return {
        model: runtime,
        ref: Ref.make({
          id: selected.id,
          providerID: selected.providerID,
          ...(variant === undefined ? {} : { variant }),
        }),
        capabilities: selected.capabilities,
        cost: selected.cost,
        limit: selected.limit,
        compaction: runtimeInfo.settings?.compaction,
        transport: provider?.settings?.transport,
        chunkTimeout: Provider.timeout(provider?.settings?.chunkTimeout),
      }
    })
    const resolveRoute = (
      selected: Info,
      definition: ModelRoute.Definition,
      requestedVariant: VariantID | undefined,
      tried: ReadonlySet<number>,
      allowCooling: boolean,
      sessionID?: string,
    ): Effect.Effect<Resolved | undefined, Error> =>
      Effect.gen(function* () {
        const now = Date.now()
        const indexes = definition.targets.flatMap((_, index) => (tried.has(index) ? [] : [index]))
        const ready = indexes.filter((index) => !ModelRoute.coolingDown(definition.targets[index], now))
        // When everything is cooling, fall back to the soonest-recovering target rather than failing.
        const candidates =
          allowCooling && ready.length === 0
            ? indexes.toSorted(
                (left, right) =>
                  ModelRoute.cooldownUntil(definition.targets[left], now) -
                  ModelRoute.cooldownUntil(definition.targets[right], now),
              )
            : ModelRoute.orderTargets(definition, new Set(ready), sessionID, allowCooling && tried.size === 0)

        let lastError: Error | undefined
        for (const index of candidates) {
          const target = definition.targets[index]
          const source = yield* models.get(target.providerID, target.id)
          if (!source?.enabled) continue
          const targetVariants = definition.targetVariants[index]
          const mapped =
            requestedVariant !== undefined ? targetVariants?.map?.[requestedVariant] : targetVariants?.default
          const resolved = yield* Effect.result(load(source, target.variant ?? mapped))
          if (Result.isFailure(resolved)) {
            ModelRoute.failed(target, definition.health, now)
            lastError = resolved.failure
            continue
          }
          const current = resolved.success
          return {
            ...current,
            // The alias advertises the safest shared request shape. Pricing and provider metadata stay
            // tied to the concrete target that answered.
            capabilities: selected.capabilities,
            limit: selected.limit,
            // A native provider checkpoint is not portable across the route's targets.
            compaction: undefined,
            routing: {
              routeID: definition.id,
              target: current.ref,
              policy: definition.health,
              fallback: () =>
                resolveRoute(selected, definition, requestedVariant, new Set([...tried, index]), false, sessionID),
            },
          }
        }
        if (lastError) return yield* Effect.fail(lastError)
        return undefined
      })

    const resolveSelected = (selected: Info, variant?: VariantID, sessionID?: string) => {
      if (selected.providerID !== ModelRoute.PROVIDER_ID) return load(selected, variant)
      const definition = ModelRoute.definition(selected)
      if (!definition || definition.targets.length === 0)
        return Effect.fail(new RouteUnavailableError({ routeID: selected.id }))
      const requestedVariant = variant === "default" ? undefined : variant
      if (requestedVariant && !selected.variants.some((item) => item.id === requestedVariant))
        return Effect.fail(
          new VariantUnavailableError({
            providerID: selected.providerID,
            modelID: selected.id,
            variant: requestedVariant,
          }),
        )
      return resolveRoute(selected, definition, requestedVariant, new Set(), true, sessionID).pipe(
        Effect.flatMap((resolved) =>
          resolved ? Effect.succeed(resolved) : Effect.fail(new RouteUnavailableError({ routeID: selected.id })),
        ),
      )
    }

    return Service.of({
      resolve: Effect.fn("ModelResolver.resolve")(function* (requested) {
        const selected = requested
          ? yield* models.get(requested.providerID, requested.id)
          : yield* models
              .default()
              .pipe(
                Effect.flatMap((model) =>
                  model && hasPackage(model)
                    ? Effect.succeed(model)
                    : Effect.map(models.available(), (models) => models.find(hasPackage)),
                ),
              )
        if (!selected) return undefined
        return yield* resolveSelected(selected, requested?.variant)
      }),
      resolveModel: (selected, variant, sessionID) => resolveSelected(selected, variant, sessionID),
    })
  }),
)

function hasConfiguredAuth(model: RuntimeInfo) {
  return [model.settings?.apiKey, model.settings?.authToken, model.settings?.accessToken].some(
    (value) => typeof value === "string" && value !== "",
  )
}

function usesAPIKeyAuth(packageName: string | undefined) {
  const name = Provider.packageName(packageName)
  return (
    name === "@ai-sdk/openai" ||
    name === "@ai-sdk/anthropic" ||
    name === "@ai-sdk/cerebras" ||
    name === "@ai-sdk/deepinfra" ||
    name === "@ai-sdk/openai-compatible" ||
    name === "@ai-sdk/google" ||
    name === "@ai-sdk/groq" ||
    name === "@ai-sdk/mistral" ||
    name === "@ai-sdk/togetherai" ||
    name === "@ai-sdk/xai" ||
    name === "@openrouter/ai-sdk-provider" ||
    name === "@ai-sdk/azure" ||
    name === "@opencode/ai/providers/openai" ||
    name?.startsWith("@opencode/ai/providers/openai/") === true ||
    name === "@opencode/ai/providers/anthropic" ||
    name === "@opencode/ai/providers/anthropic-compatible" ||
    name === "@opencode/ai/providers/baseten" ||
    name === "@opencode/ai/providers/cerebras" ||
    name === "@opencode/ai/providers/cloudflare-ai-gateway" ||
    name === "@opencode/ai/providers/cloudflare-workers-ai" ||
    name === "@opencode/ai/providers/deepinfra" ||
    name === "@opencode/ai/providers/deepseek" ||
    name === "@opencode/ai/providers/fireworks" ||
    name === "@opencode/ai/providers/openai-compatible" ||
    name === "@opencode/ai/providers/google" ||
    name === "@opencode/ai/providers/google/interactions" ||
    name === "@opencode/ai/providers/groq" ||
    name === "@opencode/ai/providers/mistral" ||
    name === "@opencode/ai/providers/togetherai" ||
    name === "@opencode/ai/providers/xai" ||
    name === "@opencode/ai/providers/openrouter" ||
    name === "@opencode/ai/providers/azure" ||
    name?.startsWith("@opencode/ai/providers/azure/") === true
  )
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Provider.node, Model.node, Integration.node, Npm.node, AISDK.node],
})
