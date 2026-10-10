import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeLocationNode, makeGlobalNode } from "@opencode/util/effect/app-node"
import { filesystem } from "@opencode/util/effect/app-node-platform"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Location } from "@opencode/core/location"
import { FileAccess } from "@opencode/core/file-access"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Agent } from "@opencode/core/agent"
import { Job } from "@opencode/core/job"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionStore } from "@opencode/core/session/store"
import { Permission } from "@opencode/core/permission"
import { PersistentPty } from "@opencode/core/persistent-pty"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { PtyTool } from "@opencode/core/tool/plugin/pty"
import { Tool } from "@opencode/core/tool"
import { Plugin } from "@opencode/core/plugin"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { toolIdentity, executeTool, registerToolPlugin, type ToolExecution } from "./lib/tool"

const sessionID = Session.ID.make("ses_pty_tool_test")
const sessionModel = Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("test") })

const permission = permissionLayer({ assert: () => Effect.void })

const ptyPluginSupervisor = makeLocationNode({
  name: "test/pty-plugins",
  layer: Layer.effectDiscard(registerToolPlugin(PtyTool.Plugin)),
  deps: [Config.node, Environment.node, FileAccess.node, Permission.node, PersistentPty.node, Tool.node],
})

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  Job.node,
  Session.node,
  SessionExecution.node,
  LocationServiceMap.node,
  filesystem,
  FSUtil.node,
  Global.node,
])

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.succeed(
    SessionExecution.Service,
    SessionExecution.Service.of({
      active: Effect.succeed(new Set()),
      isActive: () => Effect.succeed(false),
      resume: () => Effect.void,
      wake: () => Effect.void,
      interrupt: () => Effect.succeed(false),
      awaitIdle: () => Effect.void,
    }),
  ),
  deps: [Bus.node, SessionStore.node],
})

const it = testEffect(
  AppNodeBuilder.build(nodes, [
    SessionExecution.node.replace(executionNode),
    Permission.node.replace(permission),
    Global.node.replace(tempGlobalLayer),
    offlineModels,
    PluginSupervisor.node.replace(ptyPluginSupervisor),
  ]),
)

const call = (input: typeof PtyTool.Input.Type, id = "call-pty") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: PtyTool.name, input },
})

const withSession = <A, E, R>(directory: string, body: (registry: Tool.Interface) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const location = Location.Ref.make({ directory: AbsolutePath.make(directory) })
    yield* sessions.create({ id: sessionID, title: "pty test", location, model: sessionModel })
    const locations = yield* LocationServiceMap.Service
    const locationLayer = locations.get(location)
    return yield* Effect.gen(function* () {
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(toolIdentity.agent, (agent) => {
          agent.permissions = []
        }),
      )
      const plugins = yield* Plugin.Service
      yield* plugins.awaitActivation
      const registry = yield* Tool.Service
      return yield* body(registry)
    }).pipe(Effect.provide(locationLayer), Effect.ensuring(locations.invalidate(location)))
  })

const withDirectory = <A, E, R>(body: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "active")))
        return yield* body(path.join(tmp.path, "active"))
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
  )

const textOf = (execution: ToolExecution) => {
  const item = execution.content?.[0]
  return item?.type === "text" ? item.text : ""
}

const ptyIDFrom = (text: string) => {
  const match = text?.match(/Started terminal (pty\S+)/)
  if (!match) throw new Error(`no terminal id in: ${text}`)
  return match[1]
}

const waitForText = (registry: Tool.Interface, id: string, needle: string, remaining = 60): Effect.Effect<string> =>
  Effect.gen(function* () {
    const execution = yield* executeTool(registry, call({ action: "read", id }))
    const text = textOf(execution)
    if (text.includes(needle) || remaining === 0) return text
    yield* Effect.promise(() => Bun.sleep(50))
    return yield* waitForText(registry, id, needle, remaining - 1)
  })

const isWindows = process.platform === "win32"

describe("PtyTool", () => {
  const test = isWindows || !PersistentPty.available ? it.live.skip : it.live

  test("spawns a terminal, types into it, reads the screen, lists and kills it", () =>
    withDirectory((directory) =>
      withSession(directory, (registry) =>
        Effect.gen(function* () {
          const spawned = yield* executeTool(registry, call({ action: "spawn", command: "cat", title: "cat test" }))
          expect(spawned.status).toBe("completed")
          const id = ptyIDFrom(textOf(spawned))

          const written = yield* executeTool(registry, call({ action: "write", id, input: "hello\n" }, "call-write"))
          expect(written.status).toBe("completed")

          const screen = yield* waitForText(registry, id, "hello")
          expect(screen).toContain("hello")

          const listed = yield* executeTool(registry, call({ action: "list" }, "call-list"))
          expect(textOf(listed)).toContain(id)

          const resized = yield* executeTool(
            registry,
            call({ action: "resize", id, cols: 100, rows: 30 }, "call-resize"),
          )
          expect(textOf(resized)).toContain("100x30")

          const killed = yield* executeTool(registry, call({ action: "kill", id }, "call-kill"))
          expect(killed.status).toBe("completed")

          const after = yield* executeTool(registry, call({ action: "list" }, "call-list-after"))
          expect(textOf(after)).toBe("No terminals in this session.")
        }),
      ),
    ))

  test("rejects a malformed terminal ID", () =>
    withDirectory((directory) =>
      withSession(directory, (registry) =>
        Effect.gen(function* () {
          const failed = yield* executeTool(registry, call({ action: "read", id: "not-a-terminal" }))
          expect(failed.status).toBe("error")
        }),
      ),
    ))
})
