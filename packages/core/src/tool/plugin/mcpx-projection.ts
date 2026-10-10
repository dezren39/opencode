export * as McpxProjection from "./mcpx-projection.js"

import { ToolFailure } from "@opencode/ai"
import { Schema } from "effect"
import { Effect } from "effect"
import type { Editor, Info } from "../../tool.js"
import { McpxSubagent } from "./mcpx-subagent.js"

export interface ProjectedToolRecord {
  readonly id: string
  readonly namespace: string
  readonly toolName: string
  readonly originalTool: any
}

// Active projected tools by tool ID / name
const projectedTools = new Map<string, ProjectedToolRecord>()

export const getProjectedTools = (): ReadonlyMap<string, ProjectedToolRecord> => projectedTools

export const isProjected = (name: string): boolean => projectedTools.has(name)

export const clearProjectedTools = (editor?: Editor): string[] => {
  const removed: string[] = []
  for (const [id] of projectedTools) {
    if (editor) {
      try {
        editor.remove(id)
      } catch {}
    }
    removed.push(id)
  }
  projectedTools.clear()
  return removed
}

export const retractTools = (namesOrNamespaces: string[], editor?: Editor): string[] => {
  const removed: string[] = []
  const targets = new Set(namesOrNamespaces.map((s) => s.toLowerCase()))

  for (const [id, record] of projectedTools.entries()) {
    if (targets.has(id.toLowerCase()) || targets.has(record.namespace.toLowerCase()) || targets.has(record.toolName.toLowerCase())) {
      if (editor) {
        try {
          editor.remove(id)
        } catch {}
      }
      projectedTools.delete(id)
      removed.push(id)
    }
  }
  return removed
}

/**
 * Converts a raw JSON Schema or property definition into an Effect Schema struct.
 */
function buildEffectSchema(inputSchema: any): Schema.Schema<any, any> {
  if (!inputSchema || typeof inputSchema !== "object") {
    return Schema.Unknown
  }

  const props = inputSchema.properties || {}
  const required = new Set<string>(Array.isArray(inputSchema.required) ? inputSchema.required : [])
  const fields: Record<string, Schema.Schema<any, any>> = {}

  for (const [key, propDef] of Object.entries<any>(props)) {
    let fieldSchema: Schema.Schema<any, any> = Schema.Unknown
    const type = propDef?.type

    if (type === "string") {
      fieldSchema = Schema.String
    } else if (type === "number" || type === "integer") {
      fieldSchema = Schema.Number
    } else if (type === "boolean") {
      fieldSchema = Schema.Boolean
    } else if (type === "array") {
      fieldSchema = Schema.Array(Schema.Unknown)
    } else if (type === "object") {
      fieldSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown })
    }

    if (propDef?.description) {
      fieldSchema = fieldSchema.annotate({ description: propDef.description })
    }

    if (!required.has(key)) {
      fieldSchema = Schema.optionalKey(fieldSchema)
    }

    fields[key] = fieldSchema
  }

  return Schema.Struct(fields)
}

/**
 * Projects tools from mcpx namespaces into OpenCode's top-level Tool.Editor.
 */
export const projectTools = async (
  options: {
    namespaces?: string[]
    tools?: string[]
    callDaemon: (path: string, method?: string, body?: any, headers?: Record<string, string>) => Promise<any>
    editor: Editor
  },
): Promise<{ added: string[]; errors: string[] }> => {
  const added: string[] = []
  const errors: string[] = []

  const requestedNamespaces = options.namespaces ? new Set(options.namespaces.map((n) => n.toLowerCase())) : undefined
  const requestedToolNames = options.tools ? new Set(options.tools.map((t) => t.toLowerCase())) : undefined

  try {
    const rawTools: any[] = await options.callDaemon("/v1/tools")
    if (!Array.isArray(rawTools)) {
      errors.push("Invalid response from /v1/tools: expected an array")
      return { added, errors }
    }

    for (const item of rawTools) {
      const ns = String(item.namespace || item.server || "")
      const toolName = String(item.tool || "")
      const fullName = `${ns}_${toolName}`

      // Check filtering
      if (requestedNamespaces && !requestedNamespaces.has(ns.toLowerCase())) {
        continue
      }
      if (requestedToolNames && !requestedToolNames.has(toolName.toLowerCase()) && !requestedToolNames.has(fullName.toLowerCase())) {
        continue
      }

      // Check if already projected
      if (projectedTools.has(fullName)) {
        continue
      }

      try {
        const inputSchema = buildEffectSchema(item.inputSchema)
        const outputSchema = Schema.Struct({
          output: Schema.Unknown,
        })

        const toolDef: Info = {
          name: fullName,
          options: { namespace: "mcpx" },
          description: item.description ? `[mcpx:${ns}] ${item.description}` : `[mcpx:${ns}] ${toolName}`,
          input: inputSchema as any,
          output: outputSchema as any,
          execute: (args: any, context?: any) =>
            Effect.gen(function* () {
              const lease = context?.sessionID ? McpxSubagent.getLease(context.sessionID) : undefined
              const sessionID = lease ? lease.childSessionID : context?.sessionID
              const headers: Record<string, string> = {}
              if (sessionID) headers["x-mcpx-session-id"] = sessionID
              if (lease?.parentSessionID) headers["x-mcpx-parent-session-id"] = lease.parentSessionID

              const body: any = {
                server: ns,
                tool: toolName,
                arguments: args || {},
              }
              if (sessionID) body.session = sessionID

              try {
                const res = yield* Effect.tryPromise(() =>
                  options.callDaemon("/v1/call", "POST", body, Object.keys(headers).length > 0 ? headers : undefined),
                ).pipe(Effect.mapError((err: any) => new ToolFailure({ message: err?.message || String(err), error: err })))

                if (res?.error) {
                  return yield* new ToolFailure({ message: String(res.error) })
                }

                const result = res.result ?? res
                return { output: { output: result } }
              } catch (err: any) {
                return yield* new ToolFailure({
                  message: err?.message || String(err),
                  error: err,
                })
              }
            }),
        }

        options.editor.add(toolDef)
        projectedTools.set(fullName, {
          id: fullName,
          namespace: ns,
          toolName,
          originalTool: item,
        })
        added.push(fullName)
      } catch (addErr: any) {
        errors.push(`Failed to project ${fullName}: ${addErr?.message || String(addErr)}`)
      }
    }
  } catch (fetchErr: any) {
    errors.push(`Failed to fetch /v1/tools: ${fetchErr?.message || String(fetchErr)}`)
  }

  return { added, errors }
}
