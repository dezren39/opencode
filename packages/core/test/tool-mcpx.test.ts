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
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { McpxTool } from "@opencode/core/tool/plugin/mcpx"
import { Tool } from "@opencode/core/tool"
import { Plugin } from "@opencode/core/plugin"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { toolIdentity, registerToolPlugin } from "./lib/tool"

const sessionID = Session.ID.make("ses_mcpx_tool_test")
const sessionModel = Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("test") })

const permission = permissionLayer({ assert: () => Effect.void })

const mcpxPluginSupervisor = makeLocationNode({
  name: "test/mcpx-plugins",
  layer: Layer.effectDiscard(
    registerToolPlugin(McpxTool.Plugin, {
      shell: {
        hook: () => Effect.succeed({ dispose: Effect.void }),
      },
    }),
  ),
  deps: [Config.node, Environment.node, FileAccess.node, Permission.node, Tool.node],
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
    PluginSupervisor.node.replace(mcpxPluginSupervisor),
  ]),
)

const withSession = <A, E, R>(directory: string, body: (registry: Tool.Interface) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const location = Location.Ref.make({ directory: AbsolutePath.make(directory) })
    yield* sessions.create({ id: sessionID, title: "mcpx test", location, model: sessionModel })
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

describe("McpxTool", () => {
  it.live("registers mcpx_exec, mcpx_discover, and mcpx_observe tools", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      yield* withSession(tmp.path, (registry) =>
        Effect.gen(function* () {
          const tools = yield* registry.list()
          const names = tools.map((t) => t.name)
          expect(names).toContain("mcpx_exec")
          expect(names).toContain("mcpx_discover")
          expect(names).toContain("mcpx_observe")
          expect(names).toContain("mcpx_project")
          expect(names).toContain("mcpx_retract")
        }),
      )
    }),
  )
})
