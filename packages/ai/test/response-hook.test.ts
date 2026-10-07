import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { LLM } from "../src/index.js"
import { LLMClient, RequestExecutor } from "../src/route.js"
import type { HttpContext } from "../src/index.js"
import { configure } from "../src/providers/openai.js"
import { dynamicResponse } from "./lib/http.js"
import { deltaChunk, finishChunk } from "./lib/openai-chunks.js"
import { sseEvents } from "./lib/sse.js"
import { it } from "./lib/effect.js"

const model = configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).chat("gpt-4.1-mini")
const request = LLM.request({ model, prompt: "Hello" })

const limited = dynamicResponse((input) =>
  Effect.succeed(
    input.respond(sseEvents(deltaChunk({ role: "assistant", content: "Hi" }), finishChunk("stop")), {
      headers: {
        "content-type": "text/event-stream",
        "x-ratelimit-limit-requests": "60",
        "x-ratelimit-remaining-requests": "59",
        "x-ratelimit-reset-requests": "1s",
        "x-ratelimit-remaining-tokens": "0",
        "x-ratelimit-reset-tokens": "6m0s",
      },
    }),
  ),
)

describe("StreamOptions.onResponse", () => {
  it.effect("reports a successful response's headers before its events, with rate-limit details readable", () =>
    Effect.gen(function* () {
      const order: string[] = []
      let http: HttpContext | undefined
      const events = yield* LLMClient.stream(request, {
        onResponse: (value) => {
          order.push("response")
          http = value
        },
      }).pipe(
        Stream.tap(() => Effect.sync(() => order.push("event"))),
        Stream.runCollect,
        Effect.provide(limited),
      )

      expect(events.length).toBeGreaterThan(0)
      expect(order[0]).toBe("response")
      expect(order.filter((entry) => entry === "response")).toHaveLength(1)
      expect(http?.status).toBe(200)
      expect(RequestExecutor.responseRateLimit(http!.headers)).toMatchObject({
        limit: { requests: "60" },
        remaining: { requests: "59", tokens: "0" },
        reset: { requests: "1s", tokens: "6m0s" },
      })
    }),
  )

  it.effect("an observer that throws cannot break the stream it observes", () =>
    Effect.gen(function* () {
      const events = yield* LLMClient.stream(request, {
        onResponse: () => {
          throw new Error("observer failed")
        },
      }).pipe(Stream.runCollect, Effect.provide(limited))
      expect(events.length).toBeGreaterThan(0)
    }),
  )

  it.effect("is optional", () =>
    Effect.gen(function* () {
      const events = yield* LLMClient.stream(request).pipe(Stream.runCollect, Effect.provide(limited))
      expect(events.length).toBeGreaterThan(0)
    }),
  )

  it.effect("is not called for a request the provider rejected", () =>
    Effect.gen(function* () {
      let calls = 0
      const rejected = dynamicResponse((input) =>
        Effect.succeed(input.respond("{}", { status: 429, headers: { "retry-after": "5" } })),
      )
      const error = yield* LLMClient.stream(request, { onResponse: () => void calls++ }).pipe(
        Stream.runCollect,
        Effect.provide(rejected),
        Effect.flip,
      )
      expect(calls).toBe(0)
      expect(error.reason).toMatchObject({ _tag: "RateLimit" })
    }),
  )
})

describe("RequestExecutor.responseRateLimit", () => {
  test("is undefined when a response carries no rate-limit headers", () => {
    expect(RequestExecutor.responseRateLimit({ "content-type": "application/json" })).toBeUndefined()
  })

  test("reads retry-after on its own", () => {
    expect(RequestExecutor.responseRateLimit({ "retry-after": "7" })).toMatchObject({ retryAfterMs: 7_000 })
  })
})
