export * as ConfigExperimental from "./experimental.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "../schema.js"
import { ConfigPolicy } from "./policy.js"
import { ConfigModelRoutes } from "./model-routes.js"

export class Info extends Schema.Class<Info>("ConfigExperimental.Info")({
  portable_shell_scanner: Schema.Boolean.pipe(optional).annotate({
    description: "Enable the experimental portable shell permission scanner. Defaults to false.",
  }),
  subagent_depth: NonNegativeInt.pipe(optional).annotate({
    description: "Maximum subagent nesting depth. Defaults to 1.",
  }),
  policies: ConfigPolicy.Info.pipe(Schema.Array, optional).annotate({
    description: "Ordered policies controlling access to configured resources",
  }),
  model_routes: ConfigModelRoutes.Info.pipe(optional).annotate({
    description: "Named ordered provider/model routes with failure and performance failover",
  }),
  model_route_tuning: ConfigModelRoutes.Tuning.pipe(optional).annotate({
    description: "Scheduled review of routing history that adjusts model routes automatically",
  }),
}) {}
