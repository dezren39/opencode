export * as ModelRouteOverrides from "./model-route-overrides.js"

import fs from "node:fs"
import path from "node:path"
import { Global } from "@opencode/util/global"

/** `avoid` takes a target out of rotation, `prefer` favours it, `allow-over-budget` lets it run past
 * its soft budget. Each one lasts until `until`, and applies only to the targets it names. */
export type Action = "avoid" | "prefer" | "allow-over-budget"

export interface Override {
  readonly id: string
  readonly action: Action
  /** Provider IDs, compared case-insensitively. Empty means any provider. */
  readonly providers: readonly string[]
  /** Model ID patterns where `*` matches any run of characters. Empty means every model of the
   * named providers; `*` on its own is the explicit "every model" choice. */
  readonly models: readonly string[]
  /** Route IDs the override is limited to. Empty means every route. */
  readonly routes: readonly string[]
  /** Whether it reaches routes set to `fixed`. On by default: a user's word outranks the route's level. */
  readonly fixed: boolean
  /** For `prefer`: the weight multiplier. Above 1 favours the target, below 1 makes it lighter. */
  readonly factor?: number
  readonly until: number
  readonly text: string
  readonly source: "user" | "interpreter"
  readonly createdAt: number
}

const ACTIONS: readonly Action[] = ["avoid", "prefer", "allow-over-budget"]

const field = (value: unknown, name: string) =>
  value && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined

const strings = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : []

/** Keeps only well-formed entries. An entry must name at least one provider or model pattern, so a
 * malformed file can never silently apply to everything. */
export const parse = (value: unknown): Override[] => {
  const list = field(value, "overrides")
  if (!Array.isArray(list)) return []
  return list.flatMap((item): Override[] => {
    const action = field(item, "action")
    const id = field(item, "id")
    const until = field(item, "until")
    if (typeof id !== "string" || !ACTIONS.includes(action as Action)) return []
    if (typeof until !== "number" || !Number.isFinite(until)) return []
    const providers = strings(field(item, "providers"))
    const models = strings(field(item, "models"))
    if (providers.length === 0 && models.length === 0) return []
    const routes = strings(field(item, "routes"))
    const fixed = field(item, "fixed") !== false
    const factorValue = field(item, "factor")
    const factor =
      typeof factorValue === "number" && Number.isFinite(factorValue) && factorValue > 0 ? factorValue : undefined
    const text = field(item, "text")
    const source = field(item, "source")
    const createdAt = field(item, "createdAt")
    return [
      {
        id,
        action: action as Action,
        providers,
        models,
        routes,
        fixed,
        ...(factor !== undefined ? { factor } : {}),
        until,
        text: typeof text === "string" ? text : "",
        source: source === "interpreter" ? "interpreter" : "user",
        createdAt: typeof createdAt === "number" ? createdAt : 0,
      },
    ]
  })
}

const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&")

const glob = (pattern: string) => new RegExp(`^${pattern.split("*").map(escape).join(".*")}$`, "i")

/** The route a request is being chosen for, and whether that route is set to `fixed`. Without a scope
 * an override applies to every route, as it did before routes had levels. */
export interface Scope {
  readonly routeID?: string
  readonly fixed?: boolean
}

/** Whether an override is in force for a target at `now`, on a given route. */
export const applies = (
  item: Override,
  target: { readonly providerID: string; readonly id: string },
  now: number,
  scope: Scope = {},
) =>
  now < item.until &&
  (item.providers.length === 0 || item.providers.some((id) => id.toLowerCase() === target.providerID.toLowerCase())) &&
  (item.models.length === 0 || item.models.some((pattern) => glob(pattern).test(target.id))) &&
  (item.routes.length === 0 || scope.routeID === undefined || item.routes.includes(scope.routeID)) &&
  (item.fixed || scope.fixed !== true)

let location: string | undefined
let cache: { file: string; mtime: number; list: readonly Override[] } | undefined

/** Where overrides are kept: a separate file in OpenCode's data directory, so the user's config keys
 * are never rewritten and OpenChamber can read the same file. */
export const filePath = () => location ?? path.join(Global.Path.data, "route-overrides.json")

/** Test seam: point the store at another file. */
export const setFilePath = (file: string | undefined) => {
  location = file
  cache = undefined
}

/** The overrides in force, re-read only when the file changes. A missing or unreadable file is no
 * overrides, never an error that would stop routing. */
export const current = (): readonly Override[] => {
  const file = filePath()
  let mtime: number
  try {
    mtime = fs.statSync(file).mtimeMs
  } catch {
    return []
  }
  if (cache && cache.file === file && cache.mtime === mtime) return cache.list
  let list: Override[] = []
  try {
    list = parse(JSON.parse(fs.readFileSync(file, "utf8")))
  } catch {
    list = []
  }
  cache = { file, mtime, list }
  return list
}

/** Replaces the stored overrides, dropping any that have already expired. */
export const save = (overrides: readonly Override[], now = Date.now()) => {
  const file = filePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const live = overrides.filter((item) => item.until > now)
  fs.writeFileSync(file, JSON.stringify({ version: 1, overrides: live }, null, 2))
  cache = undefined
  return live
}

/** Adds one override, replacing any with the same id. */
export const add = (item: Override, now = Date.now()) =>
  save([...current().filter((existing) => existing.id !== item.id), item], now)

/** Removes one override, e.g. when the user says the interpretation was wrong. */
export const remove = (id: string, now = Date.now()) =>
  save(
    current().filter((item) => item.id !== id),
    now,
  )

/** Appends one interpretation and the user's response to it, so tendencies can be learned from it. */
export const recordFeedback = (entry: {
  readonly text: string
  readonly interpretation: unknown
  readonly accepted: boolean | "corrected"
  readonly time?: number
}) => {
  const file = path.join(path.dirname(filePath()), "route-feedback.jsonl")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify({ time: Date.now(), ...entry })}\n`)
}
