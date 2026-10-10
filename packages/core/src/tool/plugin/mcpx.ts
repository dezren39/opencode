export * as McpxTool from "./mcpx.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { execFile, spawn } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { McpxSubagent } from "./mcpx-subagent.js"
export * as McpxSubagent from "./mcpx-subagent.js"
import { McpxDiagnose, interceptToolDiagnostic } from "./mcpx-diagnose.js"
export * as McpxDiagnose from "./mcpx-diagnose.js"
import { McpxProjection, projectTools, retractTools, autoProjectFromScript, stepTurnTtl } from "./mcpx-projection.js"
export * as McpxProjection from "./mcpx-projection.js"
import { McpxSecrets, callWithSecretPrompt } from "./mcpx-secrets.js"
export * as McpxSecrets from "./mcpx-secrets.js"

export const name = "mcpx"

const defaultSocketPath = (): string => {
  if (process.env.MCPX_SOCKET) return process.env.MCPX_SOCKET
  const stateDir = process.env.MCPX_STATE_DIR ||
    (process.env.XDG_STATE_HOME ? join(process.env.XDG_STATE_HOME!, "mcpx") :
    join(homedir(), ".local", "state", "mcpx"))
  return join(stateDir, "daemon.sock")
}

const findDaemonSocket = (): string | undefined => {
  const direct = defaultSocketPath()
  if (existsSync(direct)) return direct

  // Check state directory for daemon info files
  const stateDir = process.env.MCPX_STATE_DIR ||
    (process.env.XDG_STATE_HOME ? join(process.env.XDG_STATE_HOME, "mcpx") : join(homedir(), ".local", "state", "mcpx"))
  if (existsSync(stateDir)) {
    try {
      const files = readdirSync(stateDir).filter((f) => f.startsWith("daemon-") && f.endsWith(".json"))
      for (const file of files) {
        try {
          const info = JSON.parse(readFileSync(join(stateDir, file), "utf-8"))
          if (info.socket && existsSync(info.socket)) return info.socket
        } catch {}
      }
    } catch {}
  }
  return undefined
}

export const runCli = (args: string[], env?: Record<string, string | undefined>): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      "mcpx",
      args,
      { maxBuffer: 16 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || stdout || err.message))
        } else {
          resolve(stdout || stderr)
        }
      },
    )
  })

export const callDaemon = async (
  path: string,
  method = "GET",
  body?: any,
  headers?: Record<string, string>,
): Promise<any> => {
  const endpoint = process.env.MCPX_DAEMON_ENDPOINT || process.env.MCPX_ENDPOINT
  const socket = findDaemonSocket()

  if (endpoint && endpoint.startsWith("http")) {
    const res = await fetch(`${endpoint.replace(/\/+$/, "")}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw new Error(`mcpx daemon returned HTTP ${res.status}: ${await res.text()}`)
    return await res.json()
  }

  if (socket) {
    const res = await (fetch as any)(`http://localhost${path}`, {
      unix: socket,
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw new Error(`mcpx daemon returned HTTP ${res.status}: ${await res.text()}`)
    return await res.json()
  }

  throw new Error("No mcpx daemon reachable")
}

let daemonEnsured = false

/**
 * Ensures mcpx daemon is standing and up-to-date.
 * Decoupled lifecycle:
 * - If daemon is not running, spawn detached in the background (`unref()`).
 *   OpenCode shutting down or reloading will not terminate the mcpx daemon.
 * - If daemon is already running, check if reload is needed or notify it.
 */
const ensureDaemon = async (): Promise<void> => {
  if (daemonEnsured) return
  try {
    const health = await callDaemon("/v1/health")
    if (health?.status === "ok") {
      // Daemon is standing; trigger seamless hot reload so any updated config or binary is active
      try {
        await callDaemon("/v1/reload", "POST")
      } catch {}
      daemonEnsured = true
      return
    }
  } catch {}

  // Daemon not reachable; spawn detached so it outlives opencode
  try {
    const child = spawn("mcpx", ["daemon"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    })
    child.on?.("error", () => {})
    child.unref()

    // Give daemon up to 1.5s to answer /v1/health
    const deadline = Date.now() + 1500
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
      try {
        const health = await callDaemon("/v1/health")
        if (health?.status === "ok") {
          daemonEnsured = true
          return
        }
      } catch {}
    }
  } catch {}
  daemonEnsured = true
}

export const Plugin = {
  id: "opencode.tools.mcpx",
  effect: Effect.fn("McpxTool.Plugin")(function* (ctx: Context) {
    // Opportunistically ensure daemon is standing detached in background
    yield* Effect.promise(() => ensureDaemon())

    // Wire subagent session leasing hooks
    yield* McpxSubagent.Plugin.effect(ctx)

    // Inject session leasing into shell commands
    yield* ctx.shell.hook("create.before", (invocation: any) =>
      Effect.sync(() => {
        invocation.env ??= {}
        const sessionID = invocation.sessionID ?? invocation.env?.OPENCODE_SESSION_ID
        const lease = sessionID ? McpxSubagent.getLease(sessionID) : undefined
        if (lease) {
          invocation.env.MCPX_SESSION_ID = lease.childSessionID
          invocation.env.MCPX_PARENT_SESSION_ID = lease.parentSessionID
        } else if (!invocation.env.MCPX_SESSION_ID && invocation.sessionID) {
          invocation.env.MCPX_SESSION_ID = invocation.sessionID
        }
        invocation.env.MCPX_HARNESS = "opencode"
      }),
    )

    // Intercept tool errors for mcpx_exec and projected MCP tools
    yield* Effect.sync(() => {
      try {
        ctx.tool.hook("execute.before", () =>
          Effect.sync(() => {
            stepTurnTtl()
          }),
        )
      } catch {}
      try {
        ctx.tool.hook("execute.after", (event) =>
          interceptToolDiagnostic(event, {
            callDaemon,
            getTools: () => ctx.tool.list(),
          }),
        )
      } catch {}
    })

    yield* ctx.tool.transform((editor) => {
      // 1. mcpx_exec: TypeScript Code Mode across all MCP servers
      editor.add({
        name: "mcpx_exec",
        options: { namespace: "opencode" },
        description:
          "Run TypeScript against every MCP server at once via mcpx. Tools are bound as await tools.<namespace>.<tool>({...}) and only what you print comes back, saving context tokens. Top-level await is supported.",
        input: Schema.Struct({
          source: Schema.String.annotate({ description: "TypeScript code to execute against tools.<server>.<method>()" }),
        }),
        output: Schema.Struct({
          output: Schema.String,
        }),
        execute: (input, context) =>
          Effect.gen(function* () {
            const lease = context?.sessionID ? McpxSubagent.getLease(context.sessionID) : undefined
            const sessionID = lease ? lease.childSessionID : context?.sessionID
            const headers: Record<string, string> = {}
            if (sessionID) headers["x-mcpx-session-id"] = sessionID
            if (lease?.parentSessionID) headers["x-mcpx-parent-session-id"] = lease.parentSessionID
            try {
              const body: any = { source: input.source }
              if (sessionID) body.session = sessionID
              const res = yield* Effect.tryPromise(() =>
                callDaemon("/v1/exec", "POST", body, Object.keys(headers).length > 0 ? headers : undefined),
              ).pipe(Effect.mapError((err: any) => new ToolFailure({ message: err?.message || String(err), error: err })))
              if (res?.error || (typeof res?.exitCode === "number" && res.exitCode !== 0)) {
                return yield* new ToolFailure({
                  message: res.error || res.stderr || `Execution exited with code ${res.exitCode}`,
                })
              }
              const output = res.output ?? JSON.stringify(res.result ?? res, null, 2)
              // Auto-project tools used in script with a 3-turn TTL for subsequent review
              try {
                yield* Effect.promise(() =>
                  autoProjectFromScript({
                    source: input.source,
                    callDaemon,
                    editor,
                    defaultTtl: 3,
                  }),
                )
              } catch {}
              return { output: { output: String(output) } }
            } catch {
              const env: Record<string, string> = {}
              if (sessionID) env.MCPX_SESSION_ID = sessionID
              if (lease?.parentSessionID) env.MCPX_PARENT_SESSION_ID = lease.parentSessionID
              const out = yield* Effect.tryPromise(() => runCli(["exec", input.source], env)).pipe(
                Effect.mapError((err: any) => new ToolFailure({ message: err.message, error: err })),
              )
              try {
                yield* Effect.promise(() =>
                  autoProjectFromScript({
                    source: input.source,
                    callDaemon,
                    editor,
                    defaultTtl: 3,
                  }),
                )
              } catch {}
              return { output: { output: String(out) } }
            }
          }),
      })

      // 2. mcpx_discover: server listing and tool signatures
      editor.add({
        name: "mcpx_discover",
        options: { namespace: "opencode" },
        description:
          "List the MCP servers mcpx knows about, or show signatures for one. Call with no arguments first: the answer is small and tells you what else is worth asking for.",
        input: Schema.Struct({
          namespace: Schema.optionalKey(Schema.String.annotate({ description: "Namespace to show TypeScript signatures for; omit to list all" })),
        }),
        output: Schema.Struct({
          output: Schema.String,
        }),
        execute: (input) =>
          Effect.gen(function* () {
            try {
              if (input.namespace) {
                const res = yield* Effect.tryPromise(() =>
                  callDaemon(`/v1/types?namespace=${encodeURIComponent(input.namespace!)}`),
                ).pipe(Effect.mapError((err: any) => new ToolFailure({ message: err?.message || String(err), error: err })))
                return { output: { output: typeof res === "string" ? res : JSON.stringify(res, null, 2) } }
              }
              const res = yield* Effect.tryPromise(() => callDaemon("/v1/namespaces")).pipe(
                Effect.mapError((err: any) => new ToolFailure({ message: err?.message || String(err), error: err })),
              )
              const namespaces = Array.isArray(res) ? res : (res.namespaces ?? [])
              const text = namespaces
                .map((n: any) => `${n.namespace}  (${n.tools ?? 0} tools)${n.description ? "  " + n.description : ""}`)
                .join("\n")
              return { output: { output: text || "No MCP namespaces active." } }
            } catch {
              const args = input.namespace ? ["types", input.namespace] : ["ls"]
              const out = yield* Effect.tryPromise(() => runCli(args)).pipe(
                Effect.mapError((err: any) => new ToolFailure({ message: err.message, error: err })),
              )
              return { output: { output: String(out) } }
            }
          }),
      })

      // 3. mcpx_observe: inspect durable logs and statistics
      editor.add({
        name: "mcpx_observe",
        options: { namespace: "opencode" },
        description:
          "Query what mcpx has been doing: the durable log, or aggregate statistics. Use it when a call failed and you want to know why without running it again.",
        input: Schema.Struct({
          what: Schema.Literals(["log", "calls", "errors", "servers", "slowest"]).annotate({
            description: "log for records, the rest are aggregate stats",
          }),
          since: Schema.optionalKey(Schema.String.annotate({ description: "Duration or time cutoff (e.g. 15m, 2h, or RFC3339 timestamp)" })),
        }),
        output: Schema.Struct({
          output: Schema.String,
        }),
        execute: (input) =>
          Effect.gen(function* () {
            try {
              if (input.what === "log") {
                const query = input.since ? `?since=${encodeURIComponent(input.since)}` : ""
                const res = yield* Effect.tryPromise(() => callDaemon(`/v1/log${query}`)).pipe(
                  Effect.mapError((err: any) => new ToolFailure({ message: err?.message || String(err), error: err })),
                )
                return { output: { output: JSON.stringify(res.records ?? res, null, 2) } }
              }
              const query = input.since ? `?since=${encodeURIComponent(input.since)}` : ""
              const res = yield* Effect.tryPromise(() => callDaemon(`/v1/stats/${input.what}${query}`)).pipe(
                Effect.mapError((err: any) => new ToolFailure({ message: err?.message || String(err), error: err })),
              )
              return { output: { output: JSON.stringify(res, null, 2) } }
            } catch {
              const args = input.what === "log" ? ["log", ...(input.since ? ["--since", input.since] : [])] : ["stats", input.what, ...(input.since ? ["--since", input.since] : [])]
              const out = yield* Effect.tryPromise(() => runCli(args)).pipe(
                Effect.mapError((err: any) => new ToolFailure({ message: err.message, error: err })),
              )
              return { output: { output: String(out) } }
            }
          }),
      })

      // 4. mcpx_project: Dynamic tool projection ("Ghost Tools")
      editor.add({
        name: "mcpx_project",
        options: { namespace: "opencode" },
        description:
          "Dynamically project tools from specified mcpx namespaces directly into the tool registry for this session. Projected tools become available immediately as top-level tools named <namespace>_<tool>.",
        input: Schema.Struct({
          namespaces: Schema.optionalKey(Schema.Array(Schema.String).annotate({ description: "Namespaces to project tools from (e.g. ['neon', 'chrome_devtools'])" })),
          tools: Schema.optionalKey(Schema.Array(Schema.String).annotate({ description: "Specific tool names to project (e.g. ['click', 'take_screenshot'])" })),
          ttl: Schema.optionalKey(Schema.Number.annotate({ description: "Optional number of turns this projection should remain active before auto-retracting (default: persistent until retracted)" })),
        }),
        output: Schema.Struct({
          output: Schema.String,
          projected: Schema.Array(Schema.String),
        }),
        execute: (input) =>
          Effect.gen(function* () {
            const result = yield* Effect.tryPromise(() =>
              projectTools({
                namespaces: input.namespaces,
                tools: input.tools,
                ttl: input.ttl,
                callDaemon,
                editor,
              }),
            ).pipe(Effect.mapError((err: any) => new ToolFailure({ message: err?.message || String(err), error: err })))

            const msg = `Projected ${result.added.length} tool(s): ${result.added.join(", ") || "none"}.${
              typeof input.ttl === "number" ? ` (TTL: ${input.ttl} turns)` : ""
            }${result.errors.length > 0 ? " Errors: " + result.errors.join("; ") : ""}`
            return {
              output: {
                output: msg,
                projected: result.added,
              },
            }
          }),
      })

      // 5. mcpx_retract: Dynamic tool retraction
      editor.add({
        name: "mcpx_retract",
        options: { namespace: "opencode" },
        description:
          "Retract previously projected MCP tools from the top-level tool registry to reduce schema context bloat.",
        input: Schema.Struct({
          targets: Schema.Array(Schema.String).annotate({ description: "Tool names or namespaces to retract (e.g. ['chrome_devtools', 'neon_describe_table_schema'])" }),
        }),
        output: Schema.Struct({
          output: Schema.String,
          retracted: Schema.Array(Schema.String),
        }),
        execute: (input) =>
          Effect.gen(function* () {
            const retracted = retractTools(input.targets, editor)
            const msg = `Retracted ${retracted.length} tool(s): ${retracted.join(", ") || "none"}.`
            return {
              output: {
                output: msg,
                retracted,
              },
            }
          }),
      })
    })
  }),
}
