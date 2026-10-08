export * as ModelRouteInterpret from "./model-route-interpret.js"

import type { Action } from "./model-route-overrides.js"

/** What a sentence means, before it is stored. Ids and sources are assigned when it is applied. */
export interface Draft {
  readonly action: Action
  readonly providers: readonly string[]
  readonly models: readonly string[]
  readonly until: number
  readonly text: string
}

export interface Context {
  readonly now: number
  /** Provider IDs the user has configured. */
  readonly providers: readonly string[]
  /** Models the user can route to, used to resolve "latest" versions. */
  readonly models: readonly { readonly providerID: string; readonly id: string }[]
}

export type Result =
  | {
      readonly status: "decided"
      readonly stage: string
      readonly confidence: "certain" | "tentative"
      readonly drafts: readonly Draft[]
      readonly summary: string
    }
  | {
      readonly status: "clarify"
      readonly stage: string
      readonly question: string
      /** Each option carries the drafts it would apply; a free-text answer is always allowed. */
      readonly options: readonly { readonly label: string; readonly drafts: readonly Draft[] }[]
    }
  | { readonly status: "unknown"; readonly stage: string; readonly reason: string }

/** Which interpretation stages run. Keywords are always available; the other two need a model. */
export interface Toggles {
  readonly keywords: boolean
  readonly local: boolean
  readonly external: boolean
}

export const DEFAULT_TOGGLES: Toggles = { keywords: true, local: true, external: true }

const DAY = 86_400_000
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["anthropic"],
  openai: ["openai", "gpt", "chatgpt"],
  google: ["google", "gemini"],
}
const FAMILIES = ["opus", "sonnet", "haiku"] as const

const has = (text: string, word: string) => new RegExp(`\\b${word}\\b`).test(text)

const AVOID =
  /\b(don'?t use|do not use|dont use|stop using|avoid|skip|exclude|no more|never use|is down|are down|not working|isn'?t working|is broken|keep off|turn off|without)\b/
const PREFER = /\b(prefer|favou?r|use only|only use|switch to|stick to|use|go with)\b/
const BUDGET = /\b(credits?|budget|spend|burn|unlimited|ignore (?:the )?(?:budget|limit)s?|no limit)\b/
const POOLS = /\b(include|add)\b.*\bpools?\b/

/** When the override ends: the end of today, a week, or a stated duration. Without one, a day, and
 * the result says so, so the user can correct it. */
const untilOf = (text: string, now: number) => {
  if (/\b(rest of (the )?day|today|tonight)\b/.test(text)) {
    const end = new Date(now)
    end.setHours(24, 0, 0, 0)
    return { until: end.getTime(), assumed: false }
  }
  if (/\bthis week\b/.test(text)) return { until: now + 7 * DAY, assumed: false }
  const stated = /\bfor (\d+)\s*(minutes?|mins?|hours?|hrs?|h|days?|d)\b/.exec(text)
  if (stated) {
    const unit = stated[2].startsWith("m") ? 60_000 : stated[2].startsWith("h") ? 3_600_000 : DAY
    return { until: now + Number(stated[1]) * unit, assumed: false }
  }
  return { until: now + DAY, assumed: true }
}

/** Version numbers in a model id, ignoring dates such as 20250805. */
export const versionOf = (id: string) => (id.match(/\d+/g) ?? []).map(Number).filter((value) => value < 10_000)

const newer = (left: readonly number[], right: readonly number[]) => {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a > b
  }
  return false
}

/** The newest model of a family on each provider that has one, by version number. */
export const latestOf = (family: string, models: Context["models"]) => {
  const best = new Map<string, { id: string; version: number[] }>()
  for (const model of models) {
    if (!model.id.toLowerCase().includes(family)) continue
    const version = versionOf(model.id)
    const current = best.get(model.providerID)
    if (!current || newer(version, current.version)) best.set(model.providerID, { id: model.id, version })
  }
  return [...best.entries()].map(([providerID, value]) => ({ providerID, id: value.id }))
}

const providersMentioned = (text: string, context: Context) => {
  const ids = new Set([...context.providers, ...Object.keys(ALIASES)])
  return [...ids].filter((id) => (ALIASES[id] ?? [id]).some((word) => has(text, word)))
}

const describe = (drafts: readonly Draft[], until: number, assumed: boolean) => {
  const scope = drafts
    .map((draft) =>
      [
        draft.providers.length ? draft.providers.join(", ") : "any provider",
        draft.models.length ? draft.models.join(", ") : "all models",
      ].join(" / "),
    )
    .join("; ")
  const actions = [...new Set(drafts.map((draft) => draft.action))].join(" + ")
  const when = new Date(until).toLocaleString()
  return `${actions}: ${scope}, until ${when}${assumed ? " (assumed a day; say otherwise to change it)" : ""}`
}

/**
 * The keyword stage: fixed phrases and provider or family names, with no model. Returns what it
 * understood, or one clarifying question when a phrase could mean two things. It never guesses at
 * an exclusion it cannot scope.
 */
export const keywords = (input: string, context: Context): Result => {
  const text = input.toLowerCase().replace(/[’`]/g, "'")
  const stage = "keywords"
  if (POOLS.test(text)) return { status: "unknown", stage, reason: "Adding models to pools is not supported yet." }

  const actions: Action[] = []
  if (AVOID.test(text)) actions.push("avoid")
  else if (PREFER.test(text)) actions.push("prefer")
  if (BUDGET.test(text) && !actions.includes("avoid")) actions.push("allow-over-budget")
  if (actions.length === 0)
    return { status: "unknown", stage, reason: "No action (avoid, prefer, or spend past budget) was recognised." }

  const { until, assumed } = untilOf(text, context.now)
  const providers = providersMentioned(text, context)
  const families = FAMILIES.filter((family) => has(text, family))
  const claude = has(text, "claude")
  const action = actions[0]

  if (families.length === 0 && providers.length === 0 && !claude)
    return { status: "unknown", stage, reason: "No provider or model was named." }

  // "claude" alone may mean the Anthropic provider or every Claude model on any provider.
  if (claude && providers.length === 0 && families.length === 0) {
    const drafts = (scope: Pick<Draft, "providers" | "models">) =>
      actions.map((item) => ({ action: item, ...scope, until, text: input }))
    return {
      status: "clarify",
      stage,
      question: "Do you mean the Anthropic provider, or every Claude model from any provider?",
      options: [
        { label: "Anthropic provider only", drafts: drafts({ providers: ["anthropic"], models: [] }) },
        { label: "Every Claude model, any provider", drafts: drafts({ providers: [], models: ["*claude*"] }) },
      ],
    }
  }

  if (families.length > 0 && providers.length === 0) {
    const family = families[0]
    // Excluding a family is the riskier reading, so it is confirmed before it is applied.
    if (action === "avoid") {
      const drafts = (scope: Pick<Draft, "providers" | "models">) =>
        actions.map((item) => ({ action: item, ...scope, until, text: input }))
      return {
        status: "clarify",
        stage,
        question: `Avoid ${family} from every provider, or only Anthropic's ${family}?`,
        options: [
          { label: `Every ${family}, any provider`, drafts: drafts({ providers: [], models: [`*${family}*`] }) },
          {
            label: `Only Anthropic's ${family}`,
            drafts: drafts({ providers: ["anthropic"], models: [`*${family}*`] }),
          },
        ],
      }
    }
    // Preferring a family defaults to its latest version on each provider, and says so when unsure.
    const latest = latestOf(family, context.models)
    const scopes = latest.length
      ? latest.map((model) => ({ providers: [model.providerID], models: [model.id] }))
      : [{ providers: [], models: [`*${family}*`] }]
    const drafts = scopes.flatMap((scope) => actions.map((item) => ({ action: item, ...scope, until, text: input })))
    return {
      status: "decided",
      stage,
      confidence: latest.length ? (assumed ? "tentative" : "certain") : "tentative",
      drafts,
      summary: describe(drafts, until, assumed),
    }
  }

  const models = families.map((family) => `*${family}*`)
  const drafts = actions.map((item) => ({ action: item, providers, models, until, text: input }))
  return {
    status: "decided",
    stage,
    confidence: assumed ? "tentative" : "certain",
    drafts,
    summary: describe(drafts, until, assumed),
  }
}

/** Runs the enabled stages in order. A certain answer is applied at once; a tentative one stands
 * unless a later, smarter stage returns a decision of its own. */
export const interpret = async (
  input: string,
  context: Context,
  toggles: Toggles = DEFAULT_TOGGLES,
  models: {
    readonly local?: (text: string, context: Context) => Promise<Result | undefined>
    readonly external?: (text: string, context: Context) => Promise<Result | undefined>
  } = {},
): Promise<Result> => {
  let best: Result | undefined
  if (toggles.keywords) {
    const result = keywords(input, context)
    if (result.status === "decided" && result.confidence === "certain") return result
    best = result.status === "unknown" ? best : result
  }
  for (const [name, stage] of [
    ["local", models.local],
    ["external", models.external],
  ] as const) {
    if (!toggles[name] || !stage) continue
    const result = await stage(input, context).catch(() => undefined)
    if (result && result.status !== "unknown") return result
  }
  return best ?? { status: "unknown", stage: "none", reason: "Could not tell what to change from that." }
}
