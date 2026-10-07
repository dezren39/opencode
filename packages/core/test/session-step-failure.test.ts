import { describe, expect, test } from "bun:test"
import { AIError, ProviderInternalError, QuotaExceededError, RateLimitError, TransportError } from "@opencode/ai"
import { ModelRoute } from "@opencode/core/model-route"
import { SessionStep } from "@opencode/core/session/runner/step"

const error = (reason: ConstructorParameters<typeof AIError>[0]["reason"]) => new AIError({ reason })

describe("SessionStep.failureHint", () => {
  test("reads a stated retry-after from a rate limit, directly or from its details", () => {
    expect(SessionStep.failureHint(error(new RateLimitError({ message: "slow down", retryAfterMs: 7_000 })))).toEqual({
      retryAfterMs: 7_000,
      quota: false,
      network: false,
    })
    expect(
      SessionStep.failureHint(error(new RateLimitError({ message: "slow down", rateLimit: { retryAfterMs: 9_000 } }))),
    ).toMatchObject({ retryAfterMs: 9_000, quota: false, network: false })
  })

  test("flags an exhausted quota, which carries no retry-after", () => {
    expect(SessionStep.failureHint(error(new QuotaExceededError({ message: "out of quota" })))).toEqual({
      retryAfterMs: undefined,
      quota: true,
      network: false,
    })
  })

  test("an ordinary provider failure may carry a retry-after and is never a quota", () => {
    expect(
      SessionStep.failureHint(error(new ProviderInternalError({ message: "overloaded", retryAfterMs: 3_000 }))),
    ).toEqual({ retryAfterMs: 3_000, quota: false, network: false })
    expect(
      SessionStep.failureHint(error(new TransportError({ message: "reset", transport: "http", operation: "read" }))),
    ).toEqual({ retryAfterMs: undefined, quota: false, network: true })
    expect(
      SessionStep.failureHint(
        error(
          new TransportError({
            message: "No response output within 1000ms",
            transport: "http",
            operation: "request",
            code: "Timeout",
          }),
        ),
      ),
    ).toEqual({ retryAfterMs: undefined, quota: false, network: false })
  })
})

describe("SessionStep failed attempt counter", () => {
  test("counts per key and clears on request", () => {
    expect(SessionStep.countFailedAttempt("a|x/y")).toBe(1)
    expect(SessionStep.countFailedAttempt("a|x/y")).toBe(2)
    expect(SessionStep.failedAttemptCount("a|x/y")).toBe(2)
    SessionStep.clearFailedAttempt("a|x/y")
    expect(SessionStep.failedAttemptCount("a|x/y")).toBe(0)
  })

  test("never grows past its limit and forgets the oldest keys first", () => {
    for (let index = 0; index < SessionStep.FAILED_ATTEMPT_LIMIT + 500; index++)
      SessionStep.countFailedAttempt(`bounded|${index}`)
    expect(SessionStep.failedAttemptCount()).toBeLessThanOrEqual(SessionStep.FAILED_ATTEMPT_LIMIT)
    expect(SessionStep.failedAttemptCount("bounded|0")).toBe(0)
    expect(SessionStep.failedAttemptCount(`bounded|${SessionStep.FAILED_ATTEMPT_LIMIT + 499}`)).toBe(1)
  })
})

describe("SessionStep.captureRateLimit", () => {
  const target = ModelRoute.ref({ providerID: "openai", model: "captured" })
  const http = (headers: Record<string, string>) =>
    ({ url: "https://api.example.com/v1", status: 200, headers }) as never

  test("keeps what a successful response said about OpenAI-style windows and acts on a spent one", () => {
    ModelRoute.resetHealth()
    const { capture, options } = SessionStep.captureRateLimit(target)
    options({}).onResponse?.(
      http({
        "x-ratelimit-limit-requests": "60",
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": "20s",
        "x-ratelimit-remaining-tokens": "9000",
        "x-ratelimit-limit-tokens": "10000",
        "content-type": "text/event-stream",
      }),
    )
    expect(capture.snapshot).toMatchObject({
      limit: { requests: "60", tokens: "10000" },
      remaining: { requests: "0", tokens: "9000" },
      reset: { requests: "20s" },
    })
    expect(ModelRoute.limitedUntil(target)).toBeGreaterThan(Date.now() + 15_000)
  })

  test("reads Anthropic-style windows with timestamp resets", () => {
    ModelRoute.resetHealth()
    const { capture, options } = SessionStep.captureRateLimit(target)
    const reset = new Date(Date.now() + 120_000).toISOString()
    options({}).onResponse?.(
      http({
        "anthropic-ratelimit-requests-limit": "50",
        "anthropic-ratelimit-requests-remaining": "49",
        "anthropic-ratelimit-requests-reset": reset,
        "anthropic-ratelimit-output-tokens-remaining": "0",
        "anthropic-ratelimit-output-tokens-limit": "8000",
        "anthropic-ratelimit-output-tokens-reset": reset,
      }),
    )
    expect(capture.snapshot?.remaining).toEqual({ requests: "49", "output-tokens": "0" })
    expect(ModelRoute.limitedUntil(target)).toBeGreaterThan(Date.now() + 100_000)
  })

  test("a response without rate-limit headers captures nothing and holds nothing", () => {
    ModelRoute.resetHealth()
    const { capture, options } = SessionStep.captureRateLimit(target)
    options({}).onResponse?.(http({ "content-type": "text/event-stream" }))
    expect(capture.snapshot).toBeUndefined()
    expect(ModelRoute.rateLimitOf(target)).toBeUndefined()
  })

  test("still calls an existing observer", () => {
    ModelRoute.resetHealth()
    const seen: number[] = []
    const { options } = SessionStep.captureRateLimit(target)
    options({ onResponse: (value) => void seen.push(value.status) }).onResponse?.(http({}))
    expect(seen).toEqual([200])
  })
})
