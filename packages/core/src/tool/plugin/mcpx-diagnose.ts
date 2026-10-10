export * as McpxDiagnose from "./mcpx-diagnose.js"

import { ToolFailure } from "@opencode/ai"
import { Tool } from "@opencode/schema/tool"
import type { ToolHooks } from "@opencode/plugin/effect/tool"
import { Effect, Schema } from "effect"

export interface ShapeMismatch {
  readonly property: string
  readonly expectedType: string
  readonly actualType: string
  readonly message: string
}

export interface ShapeAnalysisResult {
  readonly missingRequired: string[]
  readonly mismatches: ShapeMismatch[]
  readonly hints: string[]
}

export interface ParameterRepairResult {
  readonly repaired: boolean
  readonly repairedParams?: Record<string, unknown>
  readonly explanations: string[]
}

export interface ScriptRepairResult {
  readonly repaired: boolean
  readonly repairedSource?: string
  readonly explanations: string[]
}

export interface DiagnosticFeedback {
  readonly hasDiagnostic: boolean
  readonly typoHint?: string
  readonly shapeHints: string[]
  readonly missingParams: string[]
  readonly repairedParams?: Record<string, unknown>
  readonly repairedSource?: string
  readonly repairExplanations: string[]
  readonly formattedRepair?: string
}

/**
 * Computes Levenshtein distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))

  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      )
    }
  }

  return dp[m][n]
}

/**
 * Finds the closest matching tool name from a list of candidates.
 */
export function findClosestTool(target: string, candidates: string[]): { tool: string; distance: number } | undefined {
  if (!candidates || candidates.length === 0) return undefined
  let bestTool: string | undefined
  let bestDistance = Infinity

  const normalizedTarget = target.toLowerCase().replace(/[^a-z0-9]/g, "")

  for (const candidate of candidates) {
    if (candidate === target) continue
    const normalizedCandidate = candidate.toLowerCase().replace(/[^a-z0-9]/g, "")
    if (normalizedTarget === normalizedCandidate) {
      return { tool: candidate, distance: 0 }
    }

    const dist = levenshteinDistance(target, candidate)

    // If one is namespace-qualified (e.g. server_tool or server.tool) and the other is just the tool name
    let effectiveDist = dist
    const targetParts = target.split(/[._]/)
    const candParts = candidate.split(/[._]/)
    if (targetParts.length > 1 && candParts.length === 1) {
      const targetSuffix = targetParts.slice(1).join("_")
      effectiveDist = Math.min(effectiveDist, levenshteinDistance(targetSuffix, candidate))
    } else if (candParts.length > 1 && targetParts.length === 1) {
      const candSuffix = candParts.slice(1).join("_")
      effectiveDist = Math.min(effectiveDist, levenshteinDistance(target, candSuffix))
    }

    if (effectiveDist < bestDistance) {
      bestDistance = effectiveDist
      bestTool = candidate
    }
  }

  const threshold = Math.max(2, Math.floor(target.length * 0.45))
  if (bestTool && bestDistance <= threshold) {
    return { tool: bestTool, distance: bestDistance }
  }
  return undefined
}

/**
 * Checks for misspelled tool names and provides 'Did you mean <tool>?' hints.
 */
export function diagnoseToolTypo(toolName: string, knownTools: string[]): string | undefined {
  const match = findClosestTool(toolName, knownTools)
  if (match) {
    return `Did you mean "${match.tool}"?`
  }
  return undefined
}

/**
 * Helper to extract property definitions and required fields from either JSON Schema or Effect Schema.
 */
export function extractSchemaProperties(schema: unknown): {
  properties: Record<string, any>
  required: string[]
} {
  if (!schema || typeof schema !== "object") return { properties: {}, required: [] }

  if ("properties" in schema && typeof (schema as any).properties === "object") {
    const s = schema as any
    return {
      properties: s.properties || {},
      required: Array.isArray(s.required) ? s.required : [],
    }
  }

  if (Schema.isSchema(schema as any)) {
    try {
      const doc = Schema.toJsonSchemaDocument(schema as any)
      const s = doc.schema as any
      if (s && typeof s === "object" && s.properties) {
        return {
          properties: s.properties || {},
          required: Array.isArray(s.required) ? s.required : [],
        }
      }
    } catch {}
  }

  return { properties: {}, required: [] }
}

/**
 * Determines the target type for a property schema.
 */
export function determinePropertyType(propSchema: any): string {
  if (!propSchema) return "unknown"
  if (typeof propSchema.type === "string") return propSchema.type
  if (Array.isArray(propSchema.type)) return propSchema.type.join("|")
  if (Array.isArray(propSchema.anyOf)) {
    const types = propSchema.anyOf.map((s: any) => s.type).filter(Boolean)
    if (types.includes("number")) return "number"
    if (types.includes("integer")) return "integer"
    if (types.includes("boolean")) return "boolean"
    if (types.includes("string")) return "string"
    if (types.includes("array")) return "array"
    if (types.includes("object")) return "object"
    return types.join("|") || "unknown"
  }
  if (Array.isArray(propSchema.enum)) return "enum"
  return "unknown"
}

/**
 * Analyzes schema against provided input arguments to detect shape and type mismatches.
 */
export function analyzeArgumentMismatch(schema: unknown, input: unknown): ShapeAnalysisResult {
  const { properties, required } = extractSchemaProperties(schema)
  const missingRequired: string[] = []
  const mismatches: ShapeMismatch[] = []
  const hints: string[] = []

  const isObjectInput = typeof input === "object" && input !== null && !Array.isArray(input)
  const inputRecord = isObjectInput ? (input as Record<string, unknown>) : {}

  if (!isObjectInput) {
    if (required.length > 0) {
      hints.push(`Expected an object containing tool arguments, but received ${input === null ? "null" : typeof input}.`)
    }
    return { missingRequired: [...required], mismatches, hints }
  }

  // 1. Check missing required properties
  for (const req of required) {
    if (inputRecord[req] === undefined || inputRecord[req] === null) {
      missingRequired.push(req)
      hints.push(`Missing required parameter: "${req}". This parameter is required by the tool schema.`)
    }
  }

  // 2. Check property shape and type mismatches
  for (const [prop, propSchema] of Object.entries(properties)) {
    const val = inputRecord[prop]
    if (val === undefined || val === null) continue

    const expectedType = determinePropertyType(propSchema)
    const actualType = Array.isArray(val) ? "array" : typeof val

    if (expectedType === "array" && actualType === "string") {
      const msg = `Parameter "${prop}" shape mismatch: Expected an array, but received string ("${val}"). Pass an array of items, e.g. ["${val}"].`
      mismatches.push({ property: prop, expectedType, actualType, message: msg })
      hints.push(msg)
    } else if (expectedType === "object" && actualType === "string") {
      const msg = `Parameter "${prop}" shape mismatch: Expected an object, but received string. Pass a structured JSON object instead, e.g. { ... }.`
      mismatches.push({ property: prop, expectedType, actualType, message: msg })
      hints.push(msg)
    } else if ((expectedType === "number" || expectedType === "integer") && actualType === "string") {
      const msg = `Parameter "${prop}" type mismatch: Expected number, but received string ("${val}"). Pass a numeric value without quotes.`
      mismatches.push({ property: prop, expectedType, actualType, message: msg })
      hints.push(msg)
    } else if (expectedType === "boolean" && actualType === "string") {
      const msg = `Parameter "${prop}" type mismatch: Expected boolean, but received string ("${val}"). Pass a boolean (true/false) without quotes.`
      mismatches.push({ property: prop, expectedType, actualType, message: msg })
      hints.push(msg)
    } else if (expectedType === "string" && (actualType === "number" || actualType === "boolean")) {
      const msg = `Parameter "${prop}" type mismatch: Expected string, but received ${actualType} (${String(val)}).`
      mismatches.push({ property: prop, expectedType, actualType, message: msg })
      hints.push(msg)
    }
  }

  return { missingRequired, mismatches, hints }
}

/**
 * Attempts automatic parameter repair for known trivial errors:
 * - string-to-number coercion
 * - string-to-boolean coercion
 * - JSON string parsing for objects/arrays
 * - single string/number into array wrapping
 * - missing optional parameter or empty arguments object
 */
export function attemptParameterRepair(schema: unknown, input: unknown): ParameterRepairResult {
  const { properties } = extractSchemaProperties(schema)
  const explanations: string[] = []

  // If input is undefined or null, supply an empty argument object
  if (input === undefined || input === null) {
    return {
      repaired: true,
      repairedParams: {},
      explanations: ["Supplied empty arguments object {} for omitted parameters."],
    }
  }

  if (typeof input !== "object" || Array.isArray(input)) {
    return { repaired: false, explanations: [] }
  }

  const repaired: Record<string, unknown> = { ...(input as Record<string, unknown>) }
  let madeChanges = false

  for (const [prop, propSchema] of Object.entries(properties)) {
    const val = repaired[prop]
    if (val === undefined || val === null) {
      if (propSchema && typeof propSchema === "object" && propSchema.default !== undefined) {
        repaired[prop] = propSchema.default
        explanations.push(`Supplied default value for missing optional parameter "${prop}".`)
        madeChanges = true
      }
      continue
    }

    const expectedType = determinePropertyType(propSchema)

    // String to number coercion
    if ((expectedType === "number" || expectedType === "integer") && typeof val === "string") {
      const trimmed = val.trim()
      if (trimmed !== "" && !Number.isNaN(Number(trimmed))) {
        const num = Number(trimmed)
        repaired[prop] = expectedType === "integer" ? Math.floor(num) : num
        explanations.push(`Coerced parameter "${prop}" from string "${val}" to number ${repaired[prop]}.`)
        madeChanges = true
      }
    }

    // String to boolean coercion
    if (expectedType === "boolean" && typeof val === "string") {
      const lower = val.trim().toLowerCase()
      if (lower === "true" || lower === "false") {
        repaired[prop] = lower === "true"
        explanations.push(`Coerced parameter "${prop}" from string "${val}" to boolean ${repaired[prop]}.`)
        madeChanges = true
      }
    }

    // JSON string to object or array
    if ((expectedType === "object" || expectedType === "array") && typeof val === "string") {
      try {
        const parsed = JSON.parse(val)
        if (expectedType === "array" && Array.isArray(parsed)) {
          repaired[prop] = parsed
          explanations.push(`Parsed parameter "${prop}" from JSON string into an array.`)
          madeChanges = true
        } else if (expectedType === "object" && typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          repaired[prop] = parsed
          explanations.push(`Parsed parameter "${prop}" from JSON string into an object.`)
          madeChanges = true
        }
      } catch {
        // String to array wrapping fallback
        if (expectedType === "array" && typeof val === "string" && val.length > 0) {
          repaired[prop] = [val]
          explanations.push(`Wrapped parameter "${prop}" single value into an array.`)
          madeChanges = true
        }
      }
    }
  }

  return {
    repaired: madeChanges,
    repairedParams: madeChanges ? repaired : undefined,
    explanations,
  }
}

/**
 * Formats automatic parameter repairs into clean, human/LLM-readable diagnostic text.
 */
export function formatAutomaticRepair(repair: {
  repairedParams?: Record<string, unknown>
  repairedSource?: string
  explanations?: string[]
}): string {
  const lines: string[] = ["Automatic Parameter Repair Available:"]

  if (repair.repairedParams) {
    lines.push("Repaired parameters:")
    lines.push(JSON.stringify(repair.repairedParams, null, 2))
  }

  if (repair.repairedSource) {
    lines.push("Repaired script:")
    lines.push(repair.repairedSource)
  }

  if (repair.explanations && repair.explanations.length > 0) {
    lines.push("Applied corrections:")
    for (const exp of repair.explanations) {
      lines.push(`- ${exp}`)
    }
  }

  return lines.join("\n")
}

/**
 * Diagnoses a tool call (either projected MCP tool or direct tool execution).
 */
export function diagnoseToolCall(options: {
  toolName: string
  input: unknown
  errorMessage?: string
  schema?: unknown
  knownTools?: string[]
}): DiagnosticFeedback {
  const { toolName, input, schema, knownTools = [] } = options
  const shapeHints: string[] = []
  const missingParams: string[] = []
  const repairExplanations: string[] = []
  let typoHint: string | undefined
  let repairedParams: Record<string, unknown> | undefined

  // 1. Check for tool name typo
  if (knownTools.length > 0 && !knownTools.includes(toolName)) {
    typoHint = diagnoseToolTypo(toolName, knownTools)
  }

  // 2. Check for schema argument mismatches
  if (schema) {
    const analysis = analyzeArgumentMismatch(schema, input)
    shapeHints.push(...analysis.hints)
    missingParams.push(...analysis.missingRequired)

    // 3. Attempt parameter repair
    const repair = attemptParameterRepair(schema, input)
    if (repair.repaired) {
      repairedParams = repair.repairedParams
      repairExplanations.push(...repair.explanations)
    }
  }

  const hasDiagnostic = Boolean(
    typoHint ||
    shapeHints.length > 0 ||
    missingParams.length > 0 ||
    repairedParams !== undefined,
  )

  const formattedRepair = repairedParams
    ? formatAutomaticRepair({ repairedParams, explanations: repairExplanations })
    : undefined

  return {
    hasDiagnostic,
    typoHint,
    shapeHints,
    missingParams,
    repairedParams,
    repairExplanations,
    formattedRepair,
  }
}

/**
 * Diagnoses an mcpx script by querying mcpx daemon /v1/diagnose, or falling back to local analysis.
 */
export async function diagnoseMcpxScript(
  source: string,
  knownTools: string[] = [],
  callDaemonFn?: (path: string, method?: string, body?: any) => Promise<any>,
): Promise<DiagnosticFeedback> {
  const shapeHints: string[] = []
  const missingParams: string[] = []
  const repairExplanations: string[] = []
  let typoHint: string | undefined
  let repairedSource: string | undefined

  // 1. Try querying mcpx daemon /v1/diagnose if available
  if (callDaemonFn) {
    try {
      const res = await callDaemonFn("/v1/diagnose", "POST", { source, repair: true })
      if (res && Array.isArray(res.diagnostics)) {
        for (const d of res.diagnostics) {
          if (d.kind === "unknown-tool") {
            if (d.message?.includes("closest name")) {
              const match = /closest name it does have is ([a-zA-Z0-9_.-]+)/.exec(d.message)
              if (match?.[1]) {
                typoHint = `Did you mean "${match[1]}"?`
              }
            } else if (d.tool) {
              const toolPart = d.tool.split(".").pop() || d.tool
              typoHint = diagnoseToolTypo(toolPart, knownTools)
            }
            if (d.fix) {
              repairExplanations.push(`Suggested tool fix: ${d.fix}`)
            }
          } else if (d.kind === "missing-argument") {
            if (d.field) missingParams.push(d.field)
            shapeHints.push(d.message || `Missing required argument: ${d.field}`)
            if (d.fix) repairExplanations.push(`Fix: ${d.fix}`)
          } else if (d.kind === "unknown-argument" || d.kind === "invalid-params") {
            shapeHints.push(d.message)
          }
        }
        if (res.repaired && typeof res.repaired === "string" && res.repaired !== source) {
          repairedSource = res.repaired
          repairExplanations.push("Automatic script repair generated by mcpx daemon.")
        }
      }
    } catch {}
  }

  // 2. Fallback local analysis if daemon provided no diagnostics or was unreachable
  if (!typoHint && knownTools.length > 0) {
    // Look for tool calls in source: tools.<namespace>.<tool>(...)
    const toolCallRegex = /tools(?:\.([a-zA-Z0-9_-]+)|\[["']([^"']+)["']\])(?:\.([a-zA-Z0-9_-]+)|\[["']([^"']+)["']\])/g
    let match: RegExpExecArray | null
    while ((match = toolCallRegex.exec(source)) !== null) {
      const calledTool = match[3] || match[4]
      if (calledTool && !knownTools.includes(calledTool)) {
        const hint = diagnoseToolTypo(calledTool, knownTools)
        if (hint) {
          typoHint = hint
          const closest = findClosestTool(calledTool, knownTools)
          if (closest) {
            repairedSource = source.replace(new RegExp(`\\b${calledTool}\\b`, "g"), closest.tool)
            repairExplanations.push(`Replaced typo "${calledTool}" with "${closest.tool}".`)
          }
          break
        }
      }
    }
  }

  // Check for common trivial errors in source:
  // Missing arguments: tools.server.tool() without args -> repair to tools.server.tool({})
  const emptyCallRegex = /(tools(?:\.[a-zA-Z0-9_-]+|\[["'][^"']+["']\]){2})\s*\(\s*\)/g
  if (emptyCallRegex.test(source)) {
    repairedSource = (repairedSource || source).replace(emptyCallRegex, "$1({})")
    repairExplanations.push("Supplied empty arguments object {} for tool call.")
    shapeHints.push("Tool called without arguments. Added {} as parameter object.")
  }

  const hasDiagnostic = Boolean(
    typoHint ||
    shapeHints.length > 0 ||
    missingParams.length > 0 ||
    repairedSource !== undefined,
  )

  const formattedRepair = repairedSource
    ? formatAutomaticRepair({ repairedSource, explanations: repairExplanations })
    : undefined

  return {
    hasDiagnostic,
    typoHint,
    shapeHints,
    missingParams,
    repairedSource,
    repairExplanations,
    formattedRepair,
  }
}

/**
 * Enriches a ToolFailure result with actionable diagnostic feedback,
 * enabling immediate self-healing on the next LLM turn.
 */
export function enrichToolFailure(
  originalError: ToolFailure | Tool.Error | Error | string,
  feedback: DiagnosticFeedback,
): ToolFailure {
  const baseMessage =
    typeof originalError === "string"
      ? originalError
      : originalError instanceof Error
        ? originalError.message
        : String(originalError)

  const sections: string[] = [baseMessage, ""]
  sections.push("--- Actionable Diagnostic & Self-Healing Feedback ---")

  if (feedback.typoHint) {
    sections.push(`Typo Detected: ${feedback.typoHint}`)
  }

  if (feedback.missingParams.length > 0) {
    sections.push("Missing Required Parameters:")
    for (const p of feedback.missingParams) {
      sections.push(`- Parameter "${p}" is required and must be provided.`)
    }
  }

  if (feedback.shapeHints.length > 0) {
    sections.push("Parameter Shape / Type Issues:")
    for (const hint of feedback.shapeHints) {
      sections.push(`- ${hint}`)
    }
  }

  if (feedback.formattedRepair) {
    sections.push("")
    sections.push(feedback.formattedRepair)
  }

  sections.push("Please self-heal and adjust your tool call arguments on the next turn.")

  const enrichedMessage = sections.join("\n")

  const causeError = originalError instanceof Tool.Error ? originalError.error : originalError
  const metadata = originalError instanceof Tool.Error ? originalError.metadata : undefined

  return new ToolFailure({
    message: enrichedMessage,
    error: causeError,
    metadata: {
      ...metadata,
      diagnostic: {
        typoHint: feedback.typoHint,
        shapeHints: feedback.shapeHints,
        missingParams: feedback.missingParams,
        repairedParams: feedback.repairedParams,
        repairedSource: feedback.repairedSource,
      },
    },
  })
}

export interface InterceptorOptions {
  callDaemon?: (path: string, method?: string, body?: any) => Promise<any>
  getTools?: () => Effect.Effect<readonly (Tool.Info & { readonly id: string })[]>
}

/**
 * Intercepts tool execution errors on execute.after and enriches them with diagnostics.
 */
export function interceptToolDiagnostic(
  event: ToolHooks["execute.after"],
  options: InterceptorOptions = {},
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (event.status !== "error") return

    let registeredTools: readonly (Tool.Info & { readonly id: string })[] = []
    if (options.getTools) {
      try {
        registeredTools = yield* options.getTools()
      } catch {}
    }

    const knownToolIds = registeredTools.map((t) => t.id)
    const knownToolNames = registeredTools.map((t) => t.name)
    const allKnownTools = Array.from(new Set([...knownToolIds, ...knownToolNames]))

    // Case 1: mcpx_exec execution failure
    if (event.tool === "mcpx_exec" || event.tool.endsWith("_mcpx_exec")) {
      const source = (event.input as any)?.source
      if (typeof source === "string") {
        const feedback = yield* Effect.promise(() =>
          diagnoseMcpxScript(source, allKnownTools, options.callDaemon),
        )
        if (feedback.hasDiagnostic) {
          event.error = enrichToolFailure(event.error, feedback)
        }
      }
      return
    }

    // Case 2: Projected MCP tool failure or tool typo
    const matchedTool = registeredTools.find((t) => t.id === event.tool || t.name === event.tool)
    const schema = matchedTool?.input

    const feedback = yield* Effect.promise(() =>
      Promise.resolve(
        diagnoseToolCall({
          toolName: event.tool,
          input: event.input,
          errorMessage: event.error.message,
          schema,
          knownTools: allKnownTools,
        }),
      ),
    )

    if (feedback.hasDiagnostic) {
      event.error = enrichToolFailure(event.error, feedback)
    }
  })
}
