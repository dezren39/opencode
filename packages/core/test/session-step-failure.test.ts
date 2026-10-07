import { describe, expect, test } from "bun:test"
import { AIError, ProviderInternalError, QuotaExceededError, RateLimitError, TransportError } from "@opencode/ai"
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
