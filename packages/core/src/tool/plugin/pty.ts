export * as PtyTool from "./pty.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Pty } from "@opencode/schema/pty"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { Environment } from "../../environment/index.js"
import { FileAccess } from "../../file-access.js"
import { Permission } from "../../permission.js"
import { PersistentPty } from "../../persistent-pty.js"
import { PositiveInt } from "../../schema.js"

export const name = "pty"

const MAX_OUTPUT_LINES = 300

const description = [
  "Start and control terminals that keep running after this call returns, for programs that need interaction or stay alive (dev servers, REPLs, watchers, interactive prompts).",
  "Use spawn to start one, read to see its current screen, write to type into it, resize to change its size, list to see this session's terminals, and kill to stop one.",
  "write sends the exact text given; include \\n to press Enter and \\u0003 for Ctrl+C.",
  "For one-off commands that finish on their own, use the shell tool instead.",
].join(" ")

export const Input = Schema.Struct({
  action: Schema.Literals(["spawn", "list", "read", "write", "resize", "kill"]).annotate({
    description: "What to do: spawn, list, read, write, resize or kill.",
  }),
  command: Schema.optionalKey(Schema.String).annotate({
    description: "spawn: program to run. Omit to start the default shell.",
  }),
  args: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "spawn: arguments for the program.",
  }),
  workdir: Schema.optionalKey(Schema.String).annotate({
    description: "spawn: directory to start in. Defaults to the session's directory.",
  }),
  title: Schema.optionalKey(Schema.String).annotate({
    description: "spawn: label shown in the terminal list.",
  }),
  id: Schema.optionalKey(Schema.String).annotate({
    description: "read, write, resize and kill: the terminal ID returned by spawn or list.",
  }),
  input: Schema.optionalKey(Schema.String).annotate({
    description: "write: exact text to send.",
  }),
  cols: Schema.optionalKey(PositiveInt).annotate({ description: "spawn and resize: width in columns." }),
  rows: Schema.optionalKey(PositiveInt).annotate({ description: "spawn and resize: height in rows." }),
})

const Output = Schema.Struct({
  output: Schema.String,
  ptyID: Schema.optionalKey(Schema.String),
})

type Output = typeof Output.Type

const toolResult = (output: Output) => ({
  output,
  content: [{ type: "text" as const, text: output.output }],
  metadata: output.ptyID === undefined ? {} : { ptyID: output.ptyID },
})

const DEFAULT_COLS = 120
const DEFAULT_ROWS = 40

const parseID = (id: string): Effect.Effect<Pty.ID, Error> =>
  Schema.is(Pty.ID)(id) ? Effect.succeed(id) : Effect.fail(new Error(`Invalid terminal ID: ${id}`))

const tail = (text: string) => {
  const lines = text.split("\n")
  if (lines.length <= MAX_OUTPUT_LINES) return text
  return `[${lines.length - MAX_OUTPUT_LINES} earlier lines omitted]\n${lines.slice(-MAX_OUTPUT_LINES).join("\n")}`
}

export const Plugin = {
  id: "opencode.tool.pty",
  effect: Effect.fn("PtyTool.Plugin")(function* (ctx: Context) {
    const pty = yield* PersistentPty.Service
    const access = yield* FileAccess.Service
    const environment = yield* Environment.Service
    const permission = yield* Permission.Service

    const owned = Effect.fn("PtyTool.owned")(function* (id: Pty.ID, sessionID: Tool.Context["sessionID"]) {
      const info = yield* pty.get(id)
      if (info.sessionID !== sessionID) return yield* Effect.fail(new Error(`Terminal ${id} is not in this session`))
      return info
    })

    const spawn = Effect.fn("PtyTool.spawn")(function* (input: typeof Input.Type, context: Tool.Context) {
      const source = { type: "tool" as const, messageID: context.messageID, id: context.id }
      const target = yield* access.resolve({ path: input.workdir ?? ".", kind: "directory" })
      yield* access.authorizeExternal([target], context)
      const resource = input.command ?? "shell"
      yield* permission.assert({
        action: name,
        resources: [resource],
        save: [resource],
        sessionID: context.sessionID,
        agent: context.agent,
        source,
      })
      const workdir = yield* Environment.typeFollowing(environment.files, target.absolute).pipe(
        Effect.catchTag("Environment.NotFound", () =>
          Effect.fail(new Error(`Working directory does not exist: ${target.absolute}`)),
        ),
      )
      if (workdir !== "directory")
        return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.absolute}`))
      const info = yield* pty.create(context.sessionID, {
        command: input.command,
        args: input.args ?? [],
        cwd: target.absolute,
        title: input.title ?? resource,
        env: { AGENT: "1", OPENCODE: "1", AI_AGENT: "opencode", OPENCODE_SESSION_ID: context.sessionID },
        cols: input.cols ?? DEFAULT_COLS,
        rows: input.rows ?? DEFAULT_ROWS,
      })
      return toolResult({
        output: `Started terminal ${info.id} (${info.title}) in ${info.cwd}. Use read to see its screen and write to type into it.`,
        ptyID: info.id,
      })
    })

    const list = Effect.fn("PtyTool.list")(function* (context: Tool.Context) {
      const items = yield* pty.list(context.sessionID)
      if (items.length === 0) return toolResult({ output: "No terminals in this session." })
      return toolResult({
        output: items.map((item) => `${item.id}  ${item.title}  ${item.status}  ${item.cwd}`).join("\n"),
      })
    })

    const read = Effect.fn("PtyTool.read")(function* (id: Pty.ID, context: Tool.Context) {
      const info = yield* owned(id, context.sessionID)
      const snapshot = yield* pty.snapshot(info.id)
      return toolResult({ output: tail(snapshot.text), ptyID: info.id })
    })

    const write = Effect.fn("PtyTool.write")(function* (id: Pty.ID, data: string, context: Tool.Context) {
      const info = yield* owned(id, context.sessionID)
      yield* pty.write(info.id, data)
      return toolResult({ output: `Sent ${data.length} characters to ${info.id}.`, ptyID: info.id })
    })

    const resize = Effect.fn("PtyTool.resize")(function* (
      id: Pty.ID,
      cols: number,
      rows: number,
      context: Tool.Context,
    ) {
      const info = yield* owned(id, context.sessionID)
      yield* pty.resize(info.id, cols, rows)
      return toolResult({ output: `Resized ${info.id} to ${cols}x${rows}.`, ptyID: info.id })
    })

    const kill = Effect.fn("PtyTool.kill")(function* (id: Pty.ID, context: Tool.Context) {
      const info = yield* owned(id, context.sessionID)
      yield* pty.remove(info.id)
      return toolResult({ output: `Stopped ${info.id}.`, ptyID: info.id })
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              if (input.action === "spawn") return yield* spawn(input, context)
              if (input.action === "list") return yield* list(context)
              if (input.id === undefined) return yield* Effect.fail(new Error(`${input.action} requires id`))
              const id = yield* parseID(input.id)
              if (input.action === "read") return yield* read(id, context)
              if (input.action === "kill") return yield* kill(id, context)
              if (input.action === "write") {
                if (input.input === undefined) return yield* Effect.fail(new Error("write requires input"))
                return yield* write(id, input.input, context)
              }
              if (input.cols === undefined || input.rows === undefined)
                return yield* Effect.fail(new Error("resize requires cols and rows"))
              return yield* resize(id, input.cols, input.rows, context)
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: `pty ${input.action} failed`, error }))),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
