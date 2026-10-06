export * as SessionHedge from "./hedge.js"

import { type AIError, LLMEvent } from "@opencode/ai"
import { type Cause, Deferred, Effect, Exit, Fiber, Option, Queue, type Scope, Stream } from "effect"

/** Events that mean the model has started answering. Nothing is published, and no tool runs, before
 * one of these, which is what makes it safe to run two requests and discard one. */
const OUTPUT = new Set<LLMEvent["type"]>([
  "text-start",
  "text-delta",
  "reasoning-start",
  "reasoning-delta",
  "tool-input-start",
  "tool-input-delta",
  "tool-call",
  "media",
])

export const isOutput = (event: LLMEvent) => OUTPUT.has(event.type)

type Settled = "output" | "failed"

interface Leg {
  /** Everything the leg has produced, buffered, then whatever it produces next. */
  readonly stream: Stream.Stream<LLMEvent, AIError>
  /** Completes on the first output, or when the leg ends or fails without any. */
  readonly settled: Deferred.Deferred<Settled>
  readonly fiber: Fiber.Fiber<void>
}

const startLeg = (source: Stream.Stream<LLMEvent, AIError>): Effect.Effect<Leg, never, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<LLMEvent, AIError | Cause.Done>()
    const settled = yield* Deferred.make<Settled>()
    let output = false
    const fiber = yield* source.pipe(
      Stream.runForEach((event) =>
        Effect.suspend(() => {
          Queue.offerUnsafe(queue, event)
          if (output) return Effect.void
          if (isOutput(event)) {
            output = true
            return Deferred.succeed(settled, "output").pipe(Effect.asVoid)
          }
          if (LLMEvent.is.providerError(event)) return Deferred.succeed(settled, "failed").pipe(Effect.asVoid)
          return Effect.void
        }),
      ),
      Effect.exit,
      Effect.flatMap((exit) => (Exit.isSuccess(exit) ? Queue.end(queue) : Queue.failCause(queue, exit.cause))),
      Effect.andThen(Effect.suspend(() => Deferred.succeed(settled, output ? "output" : "failed"))),
      Effect.asVoid,
      Effect.forkScoped,
    )
    return { stream: Stream.fromQueue(queue), settled, fiber }
  })

export interface Started<T> {
  readonly value: T
  readonly stream: Stream.Stream<LLMEvent, AIError>
}

export interface Result<T> {
  readonly winner: "primary" | "hedge"
  /** The hedge's value when it won, otherwise undefined. */
  readonly value: T | undefined
  /** The hedge target's value when one was started, whoever won. */
  readonly hedgeValue: T | undefined
  /** The winner's events from the start, so the caller sees the whole response. */
  readonly stream: Stream.Stream<LLMEvent, AIError>
  readonly hedgeStarted: boolean
  /** performance.now() when the winning request was sent, for latency measurement. */
  readonly startedAt: number
  /** How long the primary had been running when the hedge started. */
  readonly primaryElapsedMs: number
}

/**
 * Sends the primary request and, if it has produced no output after `afterMs`, a second one to
 * another target. The first to produce output wins and the other is cancelled. Both run unseen: their
 * events are buffered and nothing is published until the winner is known. A target that fails
 * without output only hands the win to the other; if neither produces output within `deadlineMs`
 * the primary is returned and the caller's usual handling takes over.
 */
export const race = <T>(input: {
  readonly primary: Stream.Stream<LLMEvent, AIError>
  readonly afterMs: number
  readonly deadlineMs: number
  readonly start: Effect.Effect<Option.Option<Started<T>>>
}): Effect.Effect<Result<T>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const began = performance.now()
    const a = yield* startLeg(input.primary)
    const early = yield* Effect.raceFirst(
      Deferred.await(a.settled).pipe(Effect.as(true)),
      Effect.sleep(input.afterMs).pipe(Effect.as(false)),
    )
    const alone = (): Result<T> => ({
      winner: "primary",
      value: undefined,
      hedgeValue: undefined,
      stream: a.stream,
      hedgeStarted: false,
      startedAt: began,
      primaryElapsedMs: performance.now() - began,
    })
    if (early) return alone()
    const hedge = yield* input.start
    if (Option.isNone(hedge)) return alone()
    const hedgeBegan = performance.now()
    const b = yield* startLeg(hedge.value.stream)
    const remaining = () => Math.max(1_000, input.deadlineMs - (performance.now() - began))

    const decide = (winner: "a" | "b"): Effect.Effect<Result<T>> => {
      const loser = winner === "a" ? b : a
      return Fiber.interrupt(loser.fiber).pipe(
        Effect.as<Result<T>>(
          winner === "a"
            ? {
                winner: "primary",
                value: undefined,
                hedgeValue: hedge.value.value,
                stream: a.stream,
                hedgeStarted: true,
                startedAt: began,
                primaryElapsedMs: hedgeBegan - began,
              }
            : {
                winner: "hedge",
                value: hedge.value.value,
                hedgeValue: hedge.value.value,
                stream: b.stream,
                hedgeStarted: true,
                startedAt: hedgeBegan,
                primaryElapsedMs: hedgeBegan - began,
              },
        ),
      )
    }
    const timeout = Effect.sleep(remaining()).pipe(Effect.as("timeout" as const))
    const first = yield* Effect.raceFirst(
      Deferred.await(a.settled).pipe(Effect.map((settled) => ({ leg: "a" as const, settled }))),
      Effect.raceFirst(
        Deferred.await(b.settled).pipe(Effect.map((settled) => ({ leg: "b" as const, settled }))),
        timeout.pipe(Effect.map(() => ({ leg: "timeout" as const, settled: "failed" as const }))),
      ),
    )
    if (first.leg === "timeout") return yield* decide("a")
    if (first.settled === "output") return yield* decide(first.leg)
    // One side failed before answering: the other still gets its chance until the deadline.
    const other = first.leg === "a" ? b : a
    const rest = yield* Effect.raceFirst(
      Deferred.await(other.settled),
      Effect.sleep(remaining()).pipe(Effect.as("failed" as const)),
    )
    if (rest === "output") return yield* decide(first.leg === "a" ? "b" : "a")
    return yield* decide("a")
  })
