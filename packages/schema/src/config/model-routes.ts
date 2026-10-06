export * as ConfigModelRoutes from "./model-routes.js"

import { Schema } from "effect"
import { ConfigModel } from "./model.js"
import { optional, PositiveInt } from "../schema.js"

const BoundedPositiveInt = PositiveInt.check(Schema.isLessThanOrEqualTo(3_600_000))
const SampleCount = PositiveInt.check(Schema.isLessThanOrEqualTo(50))
const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0))

/** An ordered model target: either `provider/model`, `provider/model#variant`, or an object with
 * per-target variant defaults and remaps. */
const TargetObject = Schema.Struct({
  model: ConfigModel.Selection.annotate({
    description: "Provider/model reference. A route may reference another route.",
  }),
  defaultVariant: Schema.String.pipe(optional).annotate({
    description: "Variant used when the route is selected without an explicit variant.",
  }),
  variants: Schema.Record(Schema.String, Schema.String).pipe(optional).annotate({
    description:
      'Remaps a route-level variant to this target\'s variant, e.g. { "low": "high" } runs this target at high when the route is selected at low.',
  }),
})
export const Target = Schema.Union([ConfigModel.Selection, TargetObject]).annotate({
  identifier: "Config.ModelRoute.Target",
})
export type Target = typeof Target.Type

/** Per-target circuit-breaker and response-performance thresholds. */
export class Health extends Schema.Class<Health>("Config.ModelRoute.Health")({
  firstTokenTimeoutMs: Schema.Union([BoundedPositiveInt, Schema.Literal(false)])
    .pipe(optional)
    .annotate({
      description:
        "Fail over if the target produces no response output within this many milliseconds. Defaults to 10000.",
    }),
  maxResponseTimeMs: BoundedPositiveInt.pipe(optional).annotate({
    description: "Count a completed response as slow when it exceeds this many milliseconds.",
  }),
  minOutputTokensPerSecond: PositiveFinite.pipe(optional).annotate({
    description: "Count a completed response as slow when output throughput falls below this rate.",
  }),
  sampleWindow: SampleCount.pipe(optional).annotate({
    description: "Number of completed requests in the rolling performance window. Defaults to 5.",
  }),
  slowThreshold: SampleCount.pipe(optional).annotate({
    description: "Slow requests in the window that mark a target degraded. Defaults to 3.",
  }),
  cooldownMs: BoundedPositiveInt.pipe(optional).annotate({
    description: "How long a failed or degraded target is skipped. Defaults to 60000.",
  }),
  quotaCooldownMs: BoundedPositiveInt.pipe(optional).annotate({
    description:
      "How long a target is skipped after the provider reports an exhausted quota without saying when it resets. A reported retry-after always wins. Defaults to 900000.",
  }),
}) {}

export class Route extends Schema.Class<Route>("Config.ModelRoute.Route")({
  name: Schema.String.pipe(optional),
  targets: Schema.Array(Target).annotate({
    description: "Ordered provider/model references. A route may include another route reference.",
  }),
  health: Health.pipe(optional),
  attempts: SampleCount.pipe(optional).annotate({
    description:
      "Requests to make against one target before failing over to the next. Defaults to 1. Retries only happen before any response output, so no tool call ever runs twice.",
  }),
  selection: Schema.Literals(["ordered", "round-robin", "weighted"]).pipe(optional).annotate({
    description:
      "How a session picks its target: ordered uses the configured order (default), round-robin rotates per new session, weighted draws by weights. Either way the choice is sticky for the session and failover falls through the remaining targets in order.",
  }),
  weights: Schema.Record(Schema.String, Schema.Finite.check(Schema.isGreaterThan(0)))
    .pipe(optional)
    .annotate({
      description:
        'Relative ratios for the weighted selection mode, keyed by target model reference, e.g. { "openai/gpt-6-luna": 3, "github-copilot/gpt-6-luna": 1 } sends about 3/4 of new sessions to the first target. Targets without a weight count as 1. A nested route is keyed as "opencode-route/<id>" and is chosen as one unit by this route; it then picks among its own members using its own selection and weights.',
    }),
}) {}

const RouteID = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/))

export const Info = Schema.Record(RouteID, Route).annotate({ identifier: "Config.ModelRoutes" })
export type Info = typeof Info.Type
