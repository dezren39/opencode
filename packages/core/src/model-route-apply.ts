export * as ModelRouteApply from "./model-route-apply.js"

import { ModelRouteInterpret } from "./model-route-interpret.js"
import { ModelRouteOverrides } from "./model-route-overrides.js"

export type Outcome =
  | {
      readonly status: "applied"
      readonly overrides: readonly ModelRouteOverrides.Override[]
      readonly summary: string
    }
  | Exclude<ModelRouteInterpret.Result, { status: "decided" }>

/** Interprets one sentence. A decided result is stored at once; a question is returned for the user to answer. */
export const interpret = async (
  input: string,
  context: ModelRouteInterpret.Context,
  toggles: ModelRouteInterpret.Toggles = ModelRouteInterpret.DEFAULT_TOGGLES,
  models: Parameters<typeof ModelRouteInterpret.interpret>[3] = {},
): Promise<Outcome> => {
  const result = await ModelRouteInterpret.interpret(input, context, toggles, models)
  if (result.status !== "decided") return result
  const overrides = ModelRouteInterpret.toOverrides(result.drafts, "user", context.now)
  overrides.forEach((item) => ModelRouteOverrides.add(item, context.now))
  ModelRouteOverrides.recordFeedback({ text: input, interpretation: result, accepted: true, time: context.now })
  return { status: "applied", overrides, summary: result.summary }
}

/** Applies the option the user picked from a question. The original sentence is kept with the choice. */
export const answer = (
  input: string,
  option: { readonly label: string; readonly drafts: readonly ModelRouteInterpret.Draft[] },
  now: number,
): Outcome => {
  const overrides = ModelRouteInterpret.toOverrides(option.drafts, "user", now)
  overrides.forEach((item) => ModelRouteOverrides.add(item, now))
  ModelRouteOverrides.recordFeedback({ text: input, interpretation: option.label, accepted: "corrected", time: now })
  return { status: "applied", overrides, summary: option.label }
}
