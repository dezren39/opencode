export * as SessionStep from "./step.js"

import {
  AIError,
  InvalidProviderOutputError,
  LLMClient,
  LLMEvent,
  isContextOverflowFailure,
  TransportError,
  UnknownProviderError,
  type ProviderErrorEvent,
  type ToolCall,
} from "@opencode/ai"
import type { Agent } from "@opencode/schema/agent"
import { Cause, Clock, Data, Deferred, Duration, Effect, Exit, Fiber, Option, Result, Stream } from "effect"
import { SessionError } from "@opencode/schema/session-error"
import { Bus } from "../../bus.js"
import { Permission } from "../../permission.js"
import { Snapshot } from "../../snapshot.js"
import { Tool } from "../../tool.js"
import { ToolOutput } from "../../tool-output.js"
import { QuestionTool } from "../../tool/plugin/question.js"
import { StepFailedError } from "../error.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionSchema } from "../schema.js"
import { toSessionError } from "../to-session-error.js"
import { SessionUsage } from "../usage.js"
import { ModelRoute } from "../../model-route.js"
import { ModelRouteLog } from "../../model-route-log.js"
import { SessionRunnerModel } from "./model.js"
import { createLLMEventPublisher } from "./publish-llm-event.js"
import { SessionHedge } from "./hedge.js"
import { SessionRunnerRetry } from "./retry.js"

export type Outcome = Data.TaggedEnum<{
  Completed: { readonly needsContinuation: boolean }
  Retry: { readonly error: SessionError.Error; readonly decision: SessionRunnerRetry.Decision }
  Failover: { readonly model: SessionRunnerModel.Resolved; readonly error: SessionError.Error }
  Continue: {
    readonly error: SessionError.Error
    readonly decision: SessionRunnerRetry.Decision
  }
  RecoverFull: {}
  Compacted: {}
}>
export const Outcome = Data.taggedEnum<Outcome>()

interface Input {
  readonly isLocationClosed: () => boolean
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly agent: Agent.ID
  readonly model: SessionRunnerModel.Resolved
  readonly prepared: Omit<SessionModelRequest.Prepared, "event">
  readonly retry: (
    cause: AIError,
    error: SessionError.Error,
    retry: boolean,
  ) => Effect.Effect<{ readonly retry: false } | SessionRunnerRetry.Decision>
  readonly recoverContinuation: boolean
  /** Prepares the same request for another target of the route, so a slow attempt can be hedged. */
  readonly prepareFor?: (
    model: SessionRunnerModel.Resolved,
  ) => Effect.Effect<Omit<SessionModelRequest.Prepared, "event">>
  /** The runner owns compaction policy; the attempt invokes it only before durable output. */
  readonly recoverOverflow: Effect.Effect<boolean>
}

/** Failed attempts per assistant message and target, so a route can retry a target before failing over. */
const failedAttempts = new Map<string, number>()
const FAILED_ATTEMPT_LIMIT = 1_000

/** Cooldown input from a provider error: a stated retry-after, or an exhausted quota. */
const failureHint = (failure: AIError): ModelRoute.FailureHint => {
  const reason = failure.reason as { _tag: string; retryAfterMs?: number; rateLimit?: { retryAfterMs?: number } }
  return {
    retryAfterMs: reason.retryAfterMs ?? reason.rateLimit?.retryAfterMs,
    quota: reason._tag === "QuotaExceeded",
  }
}

const TOOLS_INTERRUPTED = { type: "aborted", message: "Tool execution interrupted" } as const
const STEP_INTERRUPTED = { type: "aborted", message: "Step interrupted" } as const
const RESULT_MISSING = { type: "tool.result-missing", message: "Provider did not return a tool result" } as const

/** Captures Location-scoped dependencies without introducing another service or execution loop. */
export const make = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const llm = yield* LLMClient.Service
  const snapshots = yield* Snapshot.Service
  const toolOutput = yield* ToolOutput.Service

  const run = Effect.fn("SessionStep.run")(function* (
    input: Input,
    /** Events already being produced for this attempt, from a hedge race. */
    raced?: { readonly stream: Stream.Stream<LLMEvent, AIError>; readonly startedAt: number },
  ) {
    const startSnapshot = yield* snapshots.capture()
    const requestStarted = raced?.startedAt ?? performance.now()
    const wallStarted = Date.now() - (performance.now() - requestStarted)
    const firstOutput = yield* Deferred.make<void>()
    const publisher = createLLMEventPublisher(bus, {
      sessionID: input.sessionID,
      assistantMessageID: input.assistantMessageID,
      agent: input.agent,
      model: input.model.ref,
      providerMetadataKey: input.model.model.route.providerMetadataKey ?? input.model.model.provider,
      snapshot: startSnapshot,
      started: yield* Clock.currentTimeMillis,
      deferStepStart: input.model.routing !== undefined,
    })
    const toolRuns: Array<{
      readonly call: ToolCall
      readonly fiber: Fiber.Fiber<void, Permission.DeclinedError | QuestionTool.CancelledError>
    }> = []
    const interruptTools = Effect.suspend(() => Fiber.interruptAll(toolRuns.map((run) => run.fiber)))
    const executeTool = (call: ToolCall) => {
      if (input.prepared.request.toolChoice?.type === "none")
        return new Tool.Error({ message: "Tools are disabled after the maximum agent steps" })
      return input.prepared.executeTool({
        sessionID: input.sessionID,
        agent: input.agent,
        messageID: input.assistantMessageID,
        call,
        progress: (update) => publisher.progress(call.id, update),
      })
    }

    // Provider and tool fibers retain per-source order without a shared writer queue.
    // A local execution starts only after its Tool.Called publication completes.
    let overflowFailure: ProviderErrorEvent | undefined
    let providerFailure: ProviderErrorEvent | undefined
    let firstOutputAt: number | undefined
    // Read to the end, not just the finish event, so the next request can reuse this response.
    const providerStream = (raced?.stream ?? llm.stream(input.prepared.request, input.prepared.options)).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (overflowFailure || providerFailure || publisher.hasProviderError()) return
          if (
            LLMEvent.is.providerError(event) &&
            isContextOverflowFailure(event) &&
            !publisher.record().outputStarted
          ) {
            overflowFailure = event
            return
          }
          const outputAlreadyStarted = publisher.record().outputStarted
          if (LLMEvent.is.providerError(event) && input.model.routing) {
            if (!outputAlreadyStarted) {
              providerFailure = event
              return
            }
            if (!event.classification) ModelRoute.failed(input.model.routing.target, input.model.routing.policy)
          }
          const receivedAt = performance.now()
          yield* publisher.publish(event)
          if (!outputAlreadyStarted && publisher.record().outputStarted && firstOutputAt === undefined) {
            firstOutputAt = receivedAt
            yield* Deferred.succeed(firstOutput, undefined)
          }
          if (event.type !== "tool-call" || event.providerExecuted) return
          toolRuns.push({
            call: event,
            fiber: yield* Effect.uninterruptibleMask((restore) =>
              restore(executeTool(event)).pipe(
                Effect.flatMap(toolOutput.truncate),
                Effect.flatMap((outcome) => publisher.toolExecution(event.id, event.name, outcome)),
                Effect.catchTag("Tool.Error", (error) =>
                  publisher.failTool(event.id, toSessionError(error), error.metadata).pipe(Effect.asVoid),
                ),
              ),
            ).pipe(Effect.forkScoped),
          })
        }),
      ),
      Effect.ensuring(publisher.flush()),
    )

    // Keep the final tool and Step events uninterruptible, even when the work itself is cancelled.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const firstTokenTimeout = input.model.routing?.policy.firstTokenTimeoutMs
        let stream: Exit.Exit<void, AIError>
        if (typeof firstTokenTimeout !== "number") {
          // Keep the established execution and interruption path unchanged for ordinary models
          // and routes that explicitly disable the first-output deadline.
          stream = yield* restore(providerStream).pipe(Effect.exit)
        } else {
          const streamFiber = yield* Effect.forkScoped(Effect.exit(restore(providerStream)))
          const timedOut = yield* restore(
            Effect.raceFirst(
              Deferred.await(firstOutput).pipe(Effect.as(false)),
              Effect.raceFirst(
                Fiber.await(streamFiber).pipe(Effect.as(false)),
                Effect.sleep(Duration.millis(firstTokenTimeout)).pipe(Effect.as(true)),
              ),
            ),
          )
          stream = timedOut
            ? yield* Fiber.interrupt(streamFiber).pipe(
                Effect.as(
                  Exit.fail(
                    new AIError({
                      reason: new TransportError({
                        message: `No response output within ${firstTokenTimeout}ms`,
                        transport: "http",
                        operation: "request",
                        code: "Timeout",
                      }),
                    }),
                  ),
                ),
              )
            : yield* Fiber.join(streamFiber)
        }
        const streamFailure = Option.getOrUndefined(Exit.findErrorOption(stream))
        const streamInterrupted = Exit.hasInterrupts(stream)
        if (!overflowFailure && publisher.hasStarted()) yield* publisher.streamed()
        if (streamInterrupted) yield* interruptTools
        const joined = yield* restore(Fiber.awaitAll(toolRuns.map((run) => run.fiber))).pipe(Effect.exit)
        if (Exit.isFailure(joined)) yield* interruptTools
        const tools = classifyToolExits(joined, toolRuns)

        const overflow = overflowFailure ?? streamFailure
        if (
          !publisher.record().outputStarted &&
          isContextOverflowFailure(overflow) &&
          (yield* restore(input.recoverOverflow))
        ) {
          yield* Effect.logWarning("provider rejected the request as too long; compacting", {
            sessionID: input.sessionID,
            model: input.model.ref,
            message: overflow?.message,
          })
          return Outcome.Compacted()
        }

        if (overflowFailure) yield* publisher.publish(overflowFailure)
        let recorded = publisher.record()
        const unknownFinish =
          Exit.isSuccess(stream) && recorded.finish?.finish === "unknown"
            ? new AIError({
                reason: new InvalidProviderOutputError({
                  message: "The provider response ended with an unknown finish reason.",
                  classification: "incomplete-stream",
                }),
              })
            : undefined
        const llmFailure =
          streamFailure instanceof AIError
            ? streamFailure
            : providerFailure
              ? new AIError({ reason: new UnknownProviderError({ message: providerFailure.message }) })
              : unknownFinish
        const failureError = llmFailure ? toSessionError(llmFailure) : undefined
        const llmError = failureError && !recorded.providerFailed ? failureError : undefined
        if (
          input.recoverContinuation &&
          llmFailure?.reason._tag === "Transport" &&
          (llmFailure.reason.recovery === "retry-full" || llmFailure.reason.recovery === "rotate-and-retry-full") &&
          !recorded.outputStarted
        )
          return Outcome.RecoverFull()
        const routeFailure =
          llmFailure !== undefined &&
          (SessionRunnerRetry.isRetryable(llmFailure) ||
            llmFailure.reason._tag === "Authentication" ||
            llmFailure.reason._tag === "QuotaExceeded")
        const retry =
          llmFailure && failureError && !isContextOverflowFailure(llmFailure)
            ? yield* restore(
                input.retry(
                  llmFailure,
                  failureError,
                  SessionRunnerRetry.isRetryable(llmFailure) ||
                    (input.model.routing !== undefined && !recorded.outputStarted && routeFailure) ||
                    (recorded.outputStarted && isInterruptedStream(llmFailure)),
                ),
              )
            : undefined

        // A target gets `attempts` tries before the route moves on. The failure only counts against
        // the target's health once it is given up on.
        const retryKey = `${input.assistantMessageID}|${input.model.ref.providerID}/${input.model.ref.id}`
        const sameTargetRetry =
          input.model.routing !== undefined &&
          llmFailure !== undefined &&
          routeFailure &&
          !recorded.outputStarted &&
          retry?.retry === true &&
          (failedAttempts.get(retryKey) ?? 0) + 1 < input.model.routing.attempts
        if (sameTargetRetry) {
          failedAttempts.set(retryKey, (failedAttempts.get(retryKey) ?? 0) + 1)
          while (failedAttempts.size > FAILED_ATTEMPT_LIMIT) failedAttempts.delete(failedAttempts.keys().next().value!)
        } else failedAttempts.delete(retryKey)
        if (input.model.routing && llmFailure && failureError && routeFailure && !sameTargetRetry) {
          ModelRoute.failed(input.model.routing.target, input.model.routing.policy, Date.now(), failureHint(llmFailure))
          if (!recorded.outputStarted && retry?.retry) {
            const fallback = yield* Effect.result(input.model.routing.fallback())
            if (Result.isSuccess(fallback) && fallback.success) {
              yield* Effect.logInfo("model route failover", {
                routeID: input.model.routing.routeID,
                from: `${input.model.routing.target.providerID}/${input.model.routing.target.id}`,
                to: `${fallback.success.ref.providerID}/${fallback.success.ref.id}`,
                reason: failureError?.message,
              })
              return Outcome.Failover({ model: fallback.success, error: failureError })
            }
          }
        }

        if (providerFailure) {
          yield* publisher.publish(providerFailure)
          recorded = publisher.record()
        }
        if (llmFailure && llmError && retry?.retry && !recorded.outputStarted) {
          // Retry state projects onto the existing assistant, even before it has produced output.
          yield* publisher.startAssistant()
          return Outcome.Retry({ error: llmError, decision: retry })
        }
        if (llmError && !recorded.providerFailed) yield* publisher.failAssistant(llmError)

        for (const decline of tools.declines)
          yield* publisher.failTool(decline.call.id, {
            type: "aborted",
            message: input.isLocationClosed()
              ? "Interaction cancelled because the location shut down"
              : decline.reason._tag === "QuestionTool.CancelledError"
                ? decline.reason.message
                : "The user declined this tool call",
          })
        const interrupted = tools.declines.length > 0 || streamInterrupted || tools.interrupted
        const toolFailure = interrupted
          ? TOOLS_INTERRUPTED
          : tools.failure !== undefined
            ? toSessionError(Cause.squash(tools.failure))
            : recorded.providerFailed
              ? TOOLS_INTERRUPTED
              : undefined
        if (toolFailure) yield* publisher.failUnsettledTools(toolFailure)
        if (interrupted) yield* publisher.failAssistant(STEP_INTERRUPTED)

        // All local fibers have joined; only provider-hosted results can still be missing.
        if (llmError || (Exit.isSuccess(stream) && !recorded.providerFailed)) {
          const missing = yield* publisher.failUnsettledTools(RESULT_MISSING, "hosted")
          if (missing && !llmError && !recorded.finish) yield* publisher.failAssistant(RESULT_MISSING)
        }

        const record = publisher.record()
        if (
          input.model.routing &&
          Exit.isSuccess(stream) &&
          record.finish &&
          !record.failure &&
          !record.providerFailed &&
          firstOutputAt !== undefined
        ) {
          const completedAt = performance.now()
          const outputDuration = Math.max(1, completedAt - firstOutputAt)
          ModelRoute.completed(input.model.routing.target, input.model.routing.policy, {
            firstTokenMs: firstOutputAt - requestStarted,
            responseMs: completedAt - requestStarted,
            tokensPerSecond: ((record.finish.tokens.output + record.finish.tokens.reasoning) * 1_000) / outputDuration,
          })
        }
        // Every attempt is logged, routed or not, so provider-wide trouble is visible across models.
        {
          const finishedAt = performance.now()
          const failed = llmFailure !== undefined
          const timedOut = failed && llmFailure.reason._tag === "Transport" && llmFailure.reason.code === "Timeout"
          const tokens = record.finish?.tokens
          ModelRoute.recordUsage(input.model.ref, tokens ? tokens.input + tokens.output + tokens.reasoning : 0)
          ModelRouteLog.record({
            kind: "attempt",
            row: {
              time_started: wallStarted,
              time_ended: Date.now(),
              session_id: input.sessionID,
              assistant_message_id: input.assistantMessageID,
              route_id: input.model.routing?.routeID ?? "",
              provider_id: input.model.ref.providerID,
              model_id: input.model.ref.id,
              variant: input.model.ref.variant,
              outcome: streamInterrupted ? "interrupted" : timedOut ? "timeout" : failed ? "failure" : "success",
              ...(failed ? ModelRouteLog.failureFields(llmFailure.reason) : {}),
              retryable: failed ? SessionRunnerRetry.isRetryable(llmFailure) : undefined,
              output_started: record.outputStarted,
              first_token_ms: firstOutputAt === undefined ? undefined : firstOutputAt - requestStarted,
              response_ms: finishedAt - requestStarted,
              tokens_per_second:
                tokens && firstOutputAt !== undefined
                  ? ((tokens.output + tokens.reasoning) * 1_000) / Math.max(1, finishedAt - firstOutputAt)
                  : undefined,
              tokens_input: tokens?.input,
              tokens_output: tokens?.output,
              tokens_reasoning: tokens?.reasoning,
              tokens_cache_read: tokens?.cache.read,
              tokens_cache_write: tokens?.cache.write,
            },
          })
        }
        if (record.finish || record.failure) {
          const snapshot = yield* snapshots.capture()
          const files =
            startSnapshot && snapshot
              ? startSnapshot === snapshot
                ? []
                : yield* snapshots
                    .files({ from: startSnapshot, to: snapshot })
                    .pipe(Effect.orElseSucceed(() => undefined))
              : undefined
          const usage = record.finish
            ? { cost: SessionUsage.calculateCost(input.model.cost, record.finish.tokens), tokens: record.finish.tokens }
            : undefined
          if (record.failure) yield* publisher.publishStepFailure({ ...usage, snapshot, files })
          if (record.finish && usage && !record.failure)
            yield* bus.publish(SessionEvent.Step.Ended, {
              sessionID: input.sessionID,
              assistantMessageID: yield* publisher.startAssistant(),
              finish: record.finish.finish,
              rawFinish: record.finish.rawFinish,
              providerState: record.finish.providerState,
              ...usage,
              snapshot,
              files,
            })
        }

        if (
          llmFailure &&
          llmError &&
          retry?.retry &&
          record.outputStarted &&
          tools.declines.length === 0 &&
          !tools.interrupted
        )
          return Outcome.Continue({ error: llmError, decision: retry })

        if (Exit.isFailure(stream)) return yield* Effect.failCause(stream.cause)
        if (tools.declines.length > 0) {
          if (input.isLocationClosed()) return Outcome.Completed({ needsContinuation: true })
          return yield* Effect.interrupt
        }
        if (tools.interrupted && tools.failure) return yield* Effect.failCause(tools.failure)
        if (tools.interrupted && Exit.isFailure(joined)) return yield* Effect.failCause(joined.cause)
        if (record.failure) return yield* new StepFailedError({ error: record.failure })
        return Outcome.Completed({
          needsContinuation: input.prepared.request.toolChoice?.type !== "none" && record.needsContinuation,
        })
      }),
    )
  }, Effect.scoped)

  /** One request, or two when the route hedges: see SessionHedge.race. */
  const attempt = Effect.fn("SessionStep.attempt")(function* (input: Input) {
    const routing = input.model.routing
    const prepareFor = input.prepareFor
    if (!routing?.hedgeAfterMs || !prepareFor) return yield* run(input)
    const raced = yield* SessionHedge.race({
      primary: llm.stream(input.prepared.request, input.prepared.options),
      afterMs: routing.hedgeAfterMs,
      deadlineMs: typeof routing.policy.firstTokenTimeoutMs === "number" ? routing.policy.firstTokenTimeoutMs : 60_000,
      // No next target, or one that cannot be prepared, simply means there is nothing to hedge with.
      start: Effect.suspend(() => routing.fallback()).pipe(
        Effect.flatMap((next) =>
          next === undefined
            ? Effect.succeed(Option.none())
            : prepareFor(next).pipe(
                Effect.map((prepared) =>
                  Option.some({
                    value: { model: next, prepared },
                    stream: llm.stream(prepared.request, prepared.options),
                  }),
                ),
              ),
        ),
        Effect.catch(() => Effect.succeed(Option.none())),
      ),
    })
    if (raced.hedgeStarted) {
      // The target that lost: the primary when the hedge answered first, otherwise the hedge.
      const loser = raced.winner === "hedge" ? input.model : raced.hedgeValue?.model
      if (raced.winner === "hedge") ModelRoute.slow(input.model.ref, routing.policy)
      ModelRouteLog.record({
        kind: "attempt",
        row: {
          time_started: Date.now() - raced.primaryElapsedMs,
          time_ended: Date.now(),
          session_id: input.sessionID,
          assistant_message_id: input.assistantMessageID,
          route_id: routing.routeID,
          provider_id: loser?.ref.providerID ?? input.model.ref.providerID,
          model_id: loser?.ref.id ?? input.model.ref.id,
          outcome: "hedged-out",
          output_started: false,
          response_ms: raced.primaryElapsedMs,
        },
      })
    }
    const winner = raced.winner === "hedge" ? raced.value : undefined
    return yield* run(winner ? { ...input, model: winner.model, prepared: winner.prepared } : input, {
      stream: raced.stream,
      startedAt: raced.startedAt,
    })
  }, Effect.scoped)

  return { attempt }
})

const isInterruptedStream = (failure: AIError) => {
  if (failure.reason._tag === "InvalidProviderOutput") return failure.reason.classification === "incomplete-stream"
  if (failure.reason._tag === "Transport") return failure.reason.operation === "read"
  return false
}

/** Tool.Error settles in each fiber; only user declines remain in the typed error channel. */
const classifyToolExits = (
  settled: Exit.Exit<Array<Exit.Exit<void, Permission.DeclinedError | QuestionTool.CancelledError>>>,
  runs: ReadonlyArray<{ readonly call: ToolCall }>,
) => {
  const exits = Exit.isSuccess(settled) ? settled.value : []
  const declines = exits.flatMap((exit, index) =>
    Exit.isFailure(exit)
      ? exit.cause.reasons.flatMap((reason) =>
          Cause.isFailReason(reason) ? [{ call: runs[index].call, reason: reason.error }] : [],
        )
      : [],
  )
  const causes = Exit.isFailure(settled)
    ? [settled.cause]
    : exits.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []))
  const failure = causes
    .flatMap((cause) => {
      if (Cause.hasInterrupts(cause)) return []
      const reasons = cause.reasons.filter(Cause.isDieReason)
      return reasons.length > 0 ? [Cause.fromReasons<never>(reasons)] : []
    })
    .at(0)
  return { interrupted: causes.some(Cause.hasInterrupts), declines, failure }
}
