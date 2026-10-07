export * as SessionGenerate from "./generate.js"

import type { FileSystem } from "../filesystem.js"
import { LLMClient, LLMResponse, Message, type AIError } from "@opencode/ai"
import { Cause, Effect, Exit } from "effect"
import { Database } from "../database/database.js"
import { Instance } from "../instance/service.js"
import { Plugin } from "../plugin/service.js"
import type { Instructions } from "../instructions/index.js"
import { SessionContext } from "./context.js"
import type { AgentNotFoundError } from "./error.js"
import { SessionHistory } from "./history.js"
import { SessionProviderContext } from "./provider-context.js"
import { ModelRoute } from "../model-route.js"
import { ModelRouteLog } from "../model-route-log.js"
import { SessionModelRequest } from "./model-request.js"
import { SessionUsage } from "./usage.js"
import type { SessionRunnerModel } from "./runner/model.js"
import type { SessionSchema } from "./schema.js"

export type Error =
  | AgentNotFoundError
  | Instructions.InitializationBlocked
  | SessionRunnerModel.Error
  | AIError
  | FileSystem.DirectoryNotFoundError

/** Generates text from current Session context without mutating the Session. */
export const generate = Effect.fn("SessionGenerate.generate")(function* (input: {
  session: SessionSchema.Info
  prompt: string
}) {
  const instances = yield* Instance.Service
  const database = yield* Database.Service
  const llm = yield* LLMClient.Service

  return yield* Effect.gen(function* () {
    yield* Plugin.awaitActivation
    const context = yield* SessionContext.Service
    const selection = yield* context.select(input.session.id)
    const model = yield* context.resolveModel(selection.session)
    const history = yield* SessionHistory.preview(
      database.db,
      selection.session.id,
      selection.instructions,
      SessionProviderContext.provenance(model) ?? "local",
    )
    const transcript = SessionModelRequest.baseTranscript({
      agent: selection.agent.info,
      model,
      tools: selection.tools,
      initial: history.initial,
      messages: history.messages,
    })
    const prepared = yield* context.request.generate({
      session: selection.session,
      agent: selection.agent.id,
      model,
      tools: selection.tools,
      system: transcript.system,
      messages: [
        ...transcript.messages,
        ...(history.instructionUpdate ? [Message.system(history.instructionUpdate)] : []),
        Message.user(input.prompt),
      ],
    })
    yield* Effect.logInfo("sending session generation request", {
      sessionID: selection.session.id,
      providerID: model.ref.providerID,
      modelID: model.ref.id,
    })
    const observed = ModelRouteLog.observer(
      {
        routeID: model.routing?.routeID ?? "",
        providerID: model.ref.providerID,
        modelID: model.ref.id,
        variant: model.ref.variant,
        sessionID: selection.session.id,
        startedAt: Date.now(),
      },
      (snapshot) => ModelRoute.observeRateLimit(model.ref, snapshot),
    )
    const started = Date.now()
    const response = yield* llm.generate(prepared.request, observed.options(prepared.options)).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          const outcome = Exit.isSuccess(exit) ? "success" : Exit.hasInterrupts(exit) ? "interrupted" : "failure"
          observed.done(outcome as "success" | "failure" | "interrupted", {
            failure: Exit.isSuccess(exit) ? undefined : Cause.squash(exit.cause),
            outputStarted: responseHasOutput(exit),
            firstOutputAt: Exit.isSuccess(exit) ? started : undefined,
            tokens: Exit.isSuccess(exit) ? responseTokens(exit.value) : undefined,
          })
        }),
      ),
    )
    yield* Effect.logInfo("session generation usage diagnostic", { usage: response.usage })
    return response.text
  }).pipe(instances.provide(input.session))
})

const responseHasOutput = (exit: Exit.Exit<LLMResponse, AIError>) => Exit.isSuccess(exit) && exit.value.text.length > 0

const responseTokens = (response: LLMResponse) => {
  const usage = response.usage
  return usage && SessionUsage.tokens(usage)
}
