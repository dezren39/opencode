export * as ConfigModelRoutes from "./model-routes.js"

import { Schema } from "effect"
import { ConfigModel } from "./model.js"
import { optional, PositiveInt } from "../schema.js"

const BoundedPositiveInt = PositiveInt.check(Schema.isLessThanOrEqualTo(3_600_000))
const SampleCount = PositiveInt.check(Schema.isLessThanOrEqualTo(50))
const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0))

/** An ordered model target, including an optional provider-specific variant. */
const Target = ConfigModel.Selection

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
}) {}

export class Route extends Schema.Class<Route>("Config.ModelRoute.Route")({
  name: Schema.String.pipe(optional),
  targets: Schema.Array(Target).annotate({
    description: "Ordered provider/model references. A route may include another route reference.",
  }),
  health: Health.pipe(optional),
}) {}

const RouteID = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/))

export const Info = Schema.Record(RouteID, Route).annotate({ identifier: "Config.ModelRoutes" })
export type Info = typeof Info.Type
