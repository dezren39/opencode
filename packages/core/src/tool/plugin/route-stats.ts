export * as RouteStatsTool from "./route-stats.js"

import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { ToolFailure } from "@opencode/ai"
import { Effect, Option, Schema } from "effect"
import type { Permission } from "../../permission.js"
import { ModelRoute } from "../../model-route.js"
import { ModelRouteLog } from "../../model-route-log.js"
import { ModelRouteTuning } from "../../model-route-tuning.js"

export const name = "route_stats"

export const description = `Read how routed models (opencode-route/*) have actually performed, to explain a routing problem or tune it.

Returns, for the last \`hours\` (default 24): attempts, failures, timeouts and average first-output latency and speed per provider/model; failures grouped by exact error tag, code and HTTP status with the latest provider message; current cooldowns; request and token usage; and the adjustments in force.
It also lists suggested adjustments derived from that history (a high failure rate, repeated quota errors, unusually slow first output). Set \`apply\` to true to put the suggestions in force; they only lower a target's share or skip it, expire in 30 minutes, and are replaced by the next run. Apply them only when asked to tune routing or when the data clearly shows a problem.`

export const Input = Schema.Struct({
  hours: Schema.Finite.check(Schema.isBetween({ minimum: 0.1, maximum: 24 * 14 })).pipe(Schema.optional),
  apply: Schema.Boolean.pipe(Schema.optional),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({
  targets: Schema.Array(Schema.Unknown),
  errors: Schema.Array(Schema.Unknown),
  suggestions: Schema.Array(Schema.Unknown),
  adjustments: Schema.Array(Schema.Unknown),
})

const MESSAGE_LIMIT = 300

export const collect = (input: Input) =>
  Effect.gen(function* () {
    const now = Date.now()
    const since = now - (input.hours ?? 24) * 3_600_000
    const read = yield* ModelRouteLog.withDb((db) =>
      Effect.all({
        stats: ModelRouteLog.targetStats(db, since),
        errors: ModelRouteLog.errorBreakdown(db, since),
      }).pipe(Effect.orDie),
    )
    const { stats, errors } = Option.getOrElse(read, () => ({ stats: [], errors: [] }))
    const targets = stats.map((row) => {
      const ref = ModelRoute.ref({ providerID: row.providerID, model: row.modelID })
      const used = ModelRoute.usageOf(ref, now)
      return {
        ...row,
        cooldownSeconds: Math.max(0, Math.round((ModelRoute.cooldownUntil(ref, now) - now) / 1000)),
        usedLastMinute: used.minute,
        usedLastDay: used.day,
      }
    })
    const suggestions = ModelRouteTuning.suggest({ stats, errors, now })
    return {
      targets,
      errors: errors.map((error) => ({ ...error, lastMessage: error.lastMessage?.slice(0, MESSAGE_LIMIT) ?? null })),
      suggestions,
      adjustments: ModelRoute.activeAdjustments(now),
      noDatabase: Option.isNone(read),
    }
  })

const describe = (report: Effect.Success<ReturnType<typeof collect>>, applied: number) => {
  if (report.noDatabase) return "Routing history is unavailable: no database is attached."
  const lines = [`${report.targets.length} targets with attempts in the window.`]
  for (const row of report.targets)
    lines.push(
      `${row.providerID}/${row.modelID}: ${row.attempts} attempts, ${row.failures} failed, ${row.timeouts} timed out, first output ${row.avgFirstTokenMs === null ? "n/a" : `${Math.round(row.avgFirstTokenMs)}ms`}, ${row.avgTokensPerSecond === null ? "n/a" : `${row.avgTokensPerSecond.toFixed(1)} tok/s`}${row.cooldownSeconds > 0 ? `, cooling ${row.cooldownSeconds}s` : ""}; used ${row.usedLastDay.requests} requests / ${row.usedLastDay.tokens} tokens in 24h`,
    )
  for (const error of report.errors)
    lines.push(
      `${error.providerID}/${error.modelID} x${error.count}: ${error.tag ?? "unknown"} ${error.code ?? ""} ${error.status ?? ""} ${error.lastMessage ?? ""}`
        .replace(/\s+/g, " ")
        .trim(),
    )
  lines.push(
    report.suggestions.length === 0
      ? "No adjustments suggested."
      : `${applied > 0 ? "Applied" : "Suggested"}: ${report.suggestions.map((item) => `${item.action} ${item.match}${item.factor ? ` x${item.factor}` : ""} (${item.note})`).join("; ")}`,
  )
  return lines.join("\n")
}

/** Reading is free; putting suggestions in force needs the same approval as `route_adjust`. */
export const add = (editor: ToolEditor, permission: Permission.Interface) =>
  editor.add({
    name,
    options: { codemode: false },
    description,
    input: Input,
    output: Output,
    execute: (input, context) =>
      Effect.gen(function* () {
        const report = yield* collect(input)
        const apply = input.apply === true && report.suggestions.length > 0
        if (apply) {
          yield* permission
            .assert({
              action: name,
              resources: report.suggestions.map((item) => item.match),
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
            })
            .pipe(Effect.mapError((error) => new ToolFailure({ message: `Permission denied: ${name}`, error })))
          for (const item of report.suggestions) ModelRoute.addAdjustment(item, item.note)
        }
        return {
          output: {
            targets: report.targets,
            errors: report.errors,
            suggestions: report.suggestions,
            adjustments: ModelRoute.activeAdjustments(),
          },
          content: describe(report, apply ? report.suggestions.length : 0),
        }
      }),
  })
