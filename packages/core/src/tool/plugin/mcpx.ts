export * as McpxTool from "./mcpx.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { execFile } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const name = "mcpx"

const defaultSocketPath = (): string => {
  if (process.env.MCPX_SOCKET) return process.env.MCPX_SOCKET
  const stateDir = process.env.MCPX_STATE_DIR ||
    process.env.XDG_STATE_HOME ? join(process.env.XDG_STATE_HOME!, "mcpx") :
    join(homedir(), ".local", "state", "mcpx")
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

const runCli = (args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("mcpx", args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || stdout || err.message))
      } else {
        resolve(stdout || stderr)
      }
    })
  })

const callDaemon = async (path: string, method = "GET", body?: any): Promise<any> => {
  const endpoint = process.env.MCPX_DAEMON_ENDPOINT || process.env.MCPX_ENDPOINT
  const socket = findDaemonSocket()

  if (endpoint && endpoint.startsWith("http")) {
    const res = await fetch(`${endpoint.replace(/\/+$/, "")}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw new Error(`mcpx daemon returned HTTP ${res.status}: ${await res.text()}`)
    return await res.json()
  }

  if (socket) {
    const res = await (fetch as any)(`http://localhost${path}`, {
      unix: socket,
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw new Error(`mcpx daemon returned HTTP ${res.status}: ${await res.text()}`)
    return await res.json()
  }

  throw new Error("No mcpx daemon reachable")
}

export const Plugin = {
  id: "opencode.tools.mcpx",
  effect: Effect.fn("McpxTool.Plugin")(function* (ctx: Context) {
    // Inject session leasing into shell commands
    yield* ctx.shell.hook("create.before", (invocation: any) =>
      Effect.sync(() => {
        invocation.env ??= {}
        if (invocation.sessionID) {
          invocation.env.MCPX_SESSION_ID = invocation.sessionID
        }
        invocation.env.MCPX_HARNESS = "opencode"
      }),
    )

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
        execute: (input) =>
          Effect.gen(function* () {
            try {
              const res = yield* Effect.tryPromise(() => callDaemon("/v1/exec", "POST", { source: input.source }))
              const output = res.output ?? JSON.stringify(res.result ?? res, null, 2)
              return { output: { output: String(output) } }
            } catch {
              const out = yield* Effect.tryPromise(() => runCli(["exec", input.source])).pipe(
                Effect.mapError((err: any) => new ToolFailure({ message: err.message, error: err })),
              )
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
                const res = yield* Effect.tryPromise(() => callDaemon(`/v1/types?namespace=${encodeURIComponent(input.namespace!)}`))
                return { output: { output: typeof res === "string" ? res : JSON.stringify(res, null, 2) } }
              }
              const res = yield* Effect.tryPromise(() => callDaemon("/v1/namespaces"))
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
                const res = yield* Effect.tryPromise(() => callDaemon(`/v1/log${query}`))
                return { output: { output: JSON.stringify(res.records ?? res, null, 2) } }
              }
              const query = input.since ? `?since=${encodeURIComponent(input.since)}` : ""
              const res = yield* Effect.tryPromise(() => callDaemon(`/v1/stats/${input.what}${query}`))
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
    })
  }),
}
