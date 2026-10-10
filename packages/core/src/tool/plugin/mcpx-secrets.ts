export * as McpxSecrets from "./mcpx-secrets.js"

import { ToolFailure } from "@opencode/ai"
import { Effect } from "effect"

export interface SecretPromptRequest {
  readonly server: string
  readonly secretKey: string
  readonly message?: string
}

export interface SecretPromptHandler {
  (request: SecretPromptRequest): Promise<string | undefined>
}

let promptHandler: SecretPromptHandler | undefined

export const setSecretPromptHandler = (handler: SecretPromptHandler | undefined): void => {
  promptHandler = handler
}

/**
 * Checks if a response error or status indicates a missing secret.
 */
export const detectMissingSecret = (errorOrBody: any): { isSecretRequired: boolean; secretKey?: string; server?: string } => {
  if (!errorOrBody) return { isSecretRequired: false }

  const errStr = typeof errorOrBody === "string" ? errorOrBody : (errorOrBody.message || errorOrBody.error || "")
  const secretKey = errorOrBody.secretRequired || errorOrBody.secretKey

  if (secretKey) {
    return {
      isSecretRequired: true,
      secretKey: String(secretKey),
      server: errorOrBody.server,
    }
  }

  // Regex patterns for common secret errors
  const match = errStr.match(/(?:missing|required)\s+(?:api[_-]?key|token|secret|credential)\s*(?::|=|\s)\s*([A-Za-z0-9_]+)/i)
    || errStr.match(/([A-Za-z0-9_]+_(?:API_KEY|TOKEN|SECRET))\s+(?:is\s+)?required/i)

  if (match) {
    return {
      isSecretRequired: true,
      secretKey: match[1],
      server: errorOrBody.server,
    }
  }

  return { isSecretRequired: false }
}

/**
 * Executes a daemon call with just-in-time secret prompting and injection on HTTP 401 / secret_required.
 */
export const callWithSecretPrompt = async (
  options: {
    path: string
    method?: string
    body?: any
    headers?: Record<string, string>
    callDaemon: (path: string, method?: string, body?: any, headers?: Record<string, string>) => Promise<any>
    promptSecret?: (request: SecretPromptRequest) => Promise<string | undefined>
  },
): Promise<any> => {
  const { path, method = "GET", body, headers = {}, callDaemon, promptSecret = promptHandler } = options

  try {
    return await callDaemon(path, method, body, headers)
  } catch (err: any) {
    const errorBody = err?.response || err
    const missing = detectMissingSecret(errorBody)

    if (missing.isSecretRequired && missing.secretKey && promptSecret) {
      const server = missing.server || body?.server || "mcpx"
      const secretVal = await promptSecret({
        server,
        secretKey: missing.secretKey,
        message: `MCP server "${server}" requires secret key "${missing.secretKey}".`,
      })

      if (secretVal) {
        // Inject into request headers or body and retry
        const updatedHeaders = {
          ...headers,
          [`x-mcpx-secret-${missing.secretKey.toLowerCase()}`]: secretVal,
          "x-mcpx-injected-secrets": JSON.stringify({ [missing.secretKey]: secretVal }),
        }
        return await callDaemon(path, method, body, updatedHeaders)
      }
    }

    throw err
  }
}
