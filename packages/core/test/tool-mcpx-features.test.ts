import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { findClosestTool, levenshteinDistance, analyzeArgumentMismatch, attemptParameterRepair } from "../src/tool/plugin/mcpx-diagnose.js"
import { generateSubagentSessionID, registerLease, getLease, removeLease, clearLeases } from "../src/tool/plugin/mcpx-subagent.js"
import { projectTools, retractTools, clearProjectedTools, getProjectedTools } from "../src/tool/plugin/mcpx-projection.js"
import { detectMissingSecret, callWithSecretPrompt } from "../src/tool/plugin/mcpx-secrets.js"

describe("Feature 2: Dynamic Tool Projection", () => {
  it("projects and retracts tools via mock daemon", async () => {
    clearProjectedTools()
    const addedTools: any[] = []
    const removedTools: string[] = []

    const mockEditor: any = {
      add: (tool: any) => addedTools.push(tool),
      remove: (id: string) => removedTools.push(id),
    }

    const mockDaemon = async (path: string) => {
      if (path === "/v1/tools") {
        return [
          {
            namespace: "neon",
            tool: "run_sql",
            description: "Run SQL on Neon Postgres",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string", description: "SQL query" },
              },
              required: ["query"],
            },
          },
          {
            namespace: "chrome_devtools",
            tool: "navigate_page",
            description: "Navigate to URL",
            inputSchema: {
              type: "object",
              properties: {
                url: { type: "string" },
              },
            },
          },
        ]
      }
      return []
    }

    // 1. Project neon tools
    const res1 = await projectTools({
      namespaces: ["neon"],
      callDaemon: mockDaemon,
      editor: mockEditor,
    })
    expect(res1.added).toContain("neon_run_sql")
    expect(res1.added).not.toContain("chrome_devtools_navigate_page")
    expect(getProjectedTools().has("neon_run_sql")).toBe(true)

    // 2. Retract neon tools
    const retracted = retractTools(["neon"], mockEditor)
    expect(retracted).toContain("neon_run_sql")
    expect(getProjectedTools().has("neon_run_sql")).toBe(false)
    expect(removedTools).toContain("neon_run_sql")
  })
})

describe("Feature 3: Ephemeral Subagent Session Leasing", () => {
  it("generates deterministic child session IDs and tracks leases", () => {
    clearLeases()
    const parentSessionID = "ses_parent_123"
    const childID = "subagent_abc"

    const expectedChildSessionID = `mcpx-sub-${parentSessionID}-${childID}`
    const generated = generateSubagentSessionID(parentSessionID, childID)
    expect(generated).toBe(expectedChildSessionID)

    registerLease({
      leaseID: generated,
      childSessionID: generated,
      childID,
      parentSessionID,
    })

    const leaseByChild = getLease(childID)
    expect(leaseByChild).toBeDefined()
    expect(leaseByChild?.childSessionID).toBe(generated)

    const leaseBySession = getLease(generated)
    expect(leaseBySession).toBeDefined()
    expect(leaseBySession?.parentSessionID).toBe(parentSessionID)

    removeLease(childID)
    expect(getLease(childID)).toBeUndefined()
  })
})

describe("Feature 4: Self-Healing & Diagnostics", () => {
  it("calculates Levenshtein distance and finds typo matches", () => {
    expect(levenshteinDistance("click", "clik")).toBe(1)
    expect(levenshteinDistance("navigate_page", "navgate_page")).toBe(1)

    const candidates = ["click", "close_page", "navigate_page", "take_screenshot"]
    const match = findClosestTool("navgate_page", candidates)
    expect(match?.tool).toBe("navigate_page")
    expect(match?.distance).toBe(1)
  })

  it("detects shape mismatches and auto-repairs parameter types", () => {
    const schema = {
      type: "object",
      properties: {
        timeout: { type: "number" },
        active: { type: "boolean" },
        tags: { type: "array" },
      },
      required: ["timeout"],
    }

    // timeout is passed as string "5000", active passed as "true"
    const input = { timeout: "5000", active: "true", tags: "foo,bar" }
    const analysis = analyzeArgumentMismatch(schema, input)
    expect(analysis.mismatches.length).toBeGreaterThan(0)

    const repair = attemptParameterRepair(schema, input)
    expect(repair.repaired).toBe(true)
    expect(repair.repairedParams?.timeout).toBe(5000)
    expect(repair.repairedParams?.active).toBe(true)
  })
})

describe("Feature 5: Just-in-Time Secret Prompting", () => {
  it("detects missing secret errors", () => {
    const error1 = { secretRequired: "NEON_API_KEY", server: "neon" }
    const res1 = detectMissingSecret(error1)
    expect(res1.isSecretRequired).toBe(true)
    expect(res1.secretKey).toBe("NEON_API_KEY")
    expect(res1.server).toBe("neon")

    const error2 = "Error: ANTHROPIC_API_KEY is required to proceed"
    const res2 = detectMissingSecret(error2)
    expect(res2.isSecretRequired).toBe(true)
    expect(res2.secretKey).toBe("ANTHROPIC_API_KEY")
  })

  it("intercepts 401 secret error and retries with injected secret", async () => {
    let callCount = 0
    let lastHeaders: Record<string, string> = {}

    const mockDaemon = async (path: string, method?: string, body?: any, headers?: Record<string, string>) => {
      callCount++
      lastHeaders = headers || {}
      if (callCount === 1) {
        throw { secretRequired: "OPENAI_API_KEY", server: "openai" }
      }
      return { success: true }
    }

    const mockPrompt = async (req: any) => {
      expect(req.secretKey).toBe("OPENAI_API_KEY")
      return "sk-test-secret-12345"
    }

    const res = await callWithSecretPrompt({
      path: "/v1/call",
      callDaemon: mockDaemon,
      promptSecret: mockPrompt,
    })

    expect(callCount).toBe(2)
    expect(res.success).toBe(true)
    expect(lastHeaders["x-mcpx-secret-openai_api_key"]).toBe("sk-test-secret-12345")
  })
})

describe("Feature 2: TTL and Script Auto-Projection", () => {
  it("decrements turn TTL and auto-retracts expired tools", () => {
    clearProjectedTools()
    const removed: string[] = []
    const mockEditor: any = {
      add: () => {},
      remove: (id: string) => removed.push(id),
    }

    const { stepTurnTtl } = require("../src/tool/plugin/mcpx-projection.js")
    const { getProjectedTools } = require("../src/tool/plugin/mcpx-projection.js")

    // Manually register a projected tool with ttl = 2
    getProjectedTools().set("test_tool", {
      id: "test_tool",
      namespace: "test",
      toolName: "tool",
      originalTool: {},
      ttlRemaining: 2,
    })

    // Turn 1 step: ttl becomes 1
    const expired1 = stepTurnTtl(mockEditor)
    expect(expired1.length).toBe(0)
    expect(getProjectedTools().has("test_tool")).toBe(true)

    // Turn 2 step: ttl becomes 0 -> retracted!
    const expired2 = stepTurnTtl(mockEditor)
    expect(expired2).toContain("test_tool")
    expect(getProjectedTools().has("test_tool")).toBe(false)
    expect(removed).toContain("test_tool")
  })
})
