export * as McpxSubagent from "./mcpx-subagent.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Predicate } from "effect"
import { SessionEnvironment } from "../../session/environment.js"
import { SessionSchema } from "../../session/schema.js"

export interface SubagentSessionLease {
  readonly leaseID: string
  readonly childSessionID: string
  readonly childID: string
  readonly parentSessionID: string
  released?: boolean
}

export const generateSubagentSessionID = (parentSessionID: string, childID: string): string =>
  `mcpx-sub-${parentSessionID}-${childID}`

export const createSubagentSessionID = generateSubagentSessionID

const leases = new Map<string, SubagentSessionLease>()

export const getLease = (id: string | undefined): SubagentSessionLease | undefined => {
  if (!id) return undefined
  return leases.get(id)
}

export const registerLease = (lease: SubagentSessionLease): void => {
  leases.set(lease.childID, lease)
  leases.set(lease.childSessionID, lease)
}

export const removeLease = (id: string): void => {
  const lease = leases.get(id)
  if (lease) {
    leases.delete(lease.childID)
    leases.delete(lease.childSessionID)
  } else {
    leases.delete(id)
  }
}

export const listLeases = (): SubagentSessionLease[] => {
  const seen = new Set<string>()
  const result: SubagentSessionLease[] = []
  for (const lease of leases.values()) {
    if (!seen.has(lease.childSessionID)) {
      seen.add(lease.childSessionID)
      result.push(lease)
    }
  }
  return result
}

export const clearLeases = (): void => {
  leases.clear()
}

export type DaemonCaller = (
  path: string,
  method?: string,
  body?: any,
  headers?: Record<string, string>,
) => Promise<any>

let daemonCallerOverride: DaemonCaller | undefined

export const setDaemonCaller = (caller: DaemonCaller | undefined): void => {
  daemonCallerOverride = caller
}

const executeCallDaemon = async (
  path: string,
  method = "GET",
  body?: any,
  headers?: Record<string, string>,
): Promise<any> => {
  if (daemonCallerOverride) {
    return daemonCallerOverride(path, method, body, headers)
  }
  const { callDaemon } = await import("./mcpx.js")
  return callDaemon(path, method, body, headers)
}

export const initializeSubagentSession = Effect.fnUntraced(function* (input: {
  parentSessionID: string
  childID: string
  environments?: Pick<SessionEnvironment.Interface, "get" | "set">
}) {
  const childSessionID = generateSubagentSessionID(input.parentSessionID, input.childID)
  const lease: SubagentSessionLease = {
    leaseID: childSessionID,
    childSessionID,
    childID: input.childID,
    parentSessionID: input.parentSessionID,
    released: false,
  }
  registerLease(lease)

  const envService =
    input.environments ??
    (yield* Effect.serviceOption(SessionEnvironment.Service).pipe(
      Effect.map((opt) => (opt._tag === "Some" ? opt.value : undefined)),
    ))

  if (envService) {
    const existing = (yield* envService.get(input.childID as SessionSchema.ID)) ?? {}
    yield* envService.set(input.childID as SessionSchema.ID, {
      ...existing,
      MCPX_SESSION_ID: childSessionID,
      MCPX_PARENT_SESSION_ID: input.parentSessionID,
    })
  }

  return lease
})

export const releaseSubagentSession = Effect.fnUntraced(function* (childOrLeaseID: string) {
  const lease = getLease(childOrLeaseID)
  const sessionToRelease = lease
    ? lease.childSessionID
    : childOrLeaseID.startsWith("mcpx-sub-")
      ? childOrLeaseID
      : undefined

  if (!sessionToRelease) return

  if (lease) {
    if (lease.released) return
    lease.released = true
    removeLease(lease.childID)
    removeLease(lease.childSessionID)
  } else {
    removeLease(childOrLeaseID)
  }

  yield* Effect.tryPromise(() =>
    executeCallDaemon("/v1/session/release", "POST", { session: sessionToRelease }),
  ).pipe(
    Effect.catchAll((error) =>
      Effect.logDebug("Failed to release mcpx subagent session lease", { error, session: sessionToRelease }),
    ),
  )
})

export const Plugin = {
  id: "opencode.tools.mcpx-subagent",
  effect: Effect.fn("McpxSubagent.Plugin")(function* (ctx: Context) {
    // Inject subagent session leasing into shell commands
    yield* ctx.shell.hook("create.before", (invocation: any) =>
      Effect.sync(() => {
        invocation.env ??= {}
        const sessionID = invocation.sessionID ?? invocation.env?.OPENCODE_SESSION_ID
        const lease = sessionID ? getLease(sessionID) : undefined
        if (lease) {
          invocation.env.MCPX_SESSION_ID = lease.childSessionID
          invocation.env.MCPX_PARENT_SESSION_ID = lease.parentSessionID
        }
      }),
    )

    // Inject subagent session leasing into tool invocations
    yield* Effect.sync(() => {
      try {
        ctx.tool.hook("execute.before", (event: any) =>
          Effect.sync(() => {
            if (!event) return
            const sessionID = event.sessionID
            const lease = sessionID ? getLease(sessionID) : undefined
            if (lease) {
              ;(event as any).env ??= {}
              if (Predicate.isObject((event as any).env)) {
                ;(event as any).env.MCPX_SESSION_ID = lease.childSessionID
                ;(event as any).env.MCPX_PARENT_SESSION_ID = lease.parentSessionID
              }
              if (Predicate.isObject(event.input)) {
                ;(event.input as any).env ??= {}
                if (Predicate.isObject((event.input as any).env)) {
                  ;(event.input as any).env.MCPX_SESSION_ID = lease.childSessionID
                  ;(event.input as any).env.MCPX_PARENT_SESSION_ID = lease.parentSessionID
                }
              }
            }
          }),
        )
      } catch {}
    })
  }),
}
