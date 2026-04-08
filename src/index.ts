/**
 * CERT + Cloudflare AI Gateway Integration Demo
 *
 * Demonstrates CERT operating as a hallucination detection layer
 * over Cloudflare AI Gateway.
 *
 * Request flow:
 *   Client -> This Worker -> CF AI Gateway -> LLM Provider
 *                         |
 *                  CERT grounding score logged to CERT dashboard
 *
 * The worker:
 * 1. Forwards the LLM request to CF AI Gateway (unchanged)
 * 2. Captures the response
 * 3. POSTs input+output to CERT for async grounding evaluation
 * 4. Adds X-CERT-Grounding-Pending header so clients know evaluation is queued
 * 5. Returns the original LLM response to the client (no latency added)
 */

import { Env, CertTracePayload, GatewayResponse } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── Route dispatch — path first, method validated per route ──────────
    //
    // Health check — GET only, no auth required.
    // Must come before the POST-only LLM proxy routes.
    if (url.pathname === "/health") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      return Response.json({ status: "ok", version: "0.1.0" });
    }

    // All LLM proxy routes — POST only.
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Clone request before reading body (body can only be read once)
    const requestClone = request.clone();

    let requestBody: Record<string, unknown>;
    try {
      requestBody = await requestClone.json();
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    // Extract the input text from the LLM request
    const inputText = extractInputText(requestBody);

    // Extract context if provided (for RAG use cases)
    const contextText = extractContextText(requestBody);

    // Build the AI Gateway URL
    // Format: https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/{provider}
    const gatewayUrl = buildGatewayUrl(env, url.pathname);

    // Forward to AI Gateway — preserve all original headers except Host
    const gatewayHeaders = new Headers(request.headers);
    gatewayHeaders.delete("host");

    let gatewayResponse: Response;
    let gatewayDuration = 0;
    const gatewayStart = Date.now();

    try {
      gatewayResponse = await fetch(gatewayUrl, {
        method: "POST",
        headers: gatewayHeaders,
        body: JSON.stringify(requestBody),
      });
      gatewayDuration = Date.now() - gatewayStart;
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Gateway request failed", detail: String(err) }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    // Clone gateway response to read body while still returning original
    const responseClone = gatewayResponse.clone();

    let responseBody: GatewayResponse;
    let outputText = "";
    try {
      responseBody = await responseClone.json() as GatewayResponse;
      outputText = extractOutputText(responseBody);
    } catch {
      // If response isn't JSON (streaming, error), return it unchanged
      return gatewayResponse;
    }

    // Fire-and-forget: log trace to CERT asynchronously.
    // ctx.waitUntil() ensures this completes after response is sent —
    // zero latency impact on the client.
    if (inputText && outputText && env.CERT_API_KEY) {
      const tracePayload: CertTracePayload = {
        traces: [{
          trace_id: crypto.randomUUID(),
          name: `cf-gateway.${extractModelName(requestBody)}`,
          llm_vendor: extractProvider(url.pathname),
          model: extractModelName(requestBody),
          input_text: inputText,
          output_text: outputText,
          knowledge_base: contextText || undefined,
          evaluation_mode: contextText ? "grounded" : "ungrounded",
          duration_ms: gatewayDuration,
          source: "gateway",
          project_name: env.CERT_PROJECT || "cloudflare-gateway",
          timestamp: new Date().toISOString(),
        }],
      };

      ctx.waitUntil(
        postToCert(env.CERT_API_KEY, env.CERT_DASHBOARD_URL, tracePayload)
      );
    }

    // Return original gateway response with CERT headers appended
    const responseHeaders = new Headers(gatewayResponse.headers);
    responseHeaders.set("X-CERT-Grounding-Pending", "true");
    responseHeaders.set("X-CERT-Project", env.CERT_PROJECT || "cloudflare-gateway");

    return new Response(JSON.stringify(responseBody), {
      status: gatewayResponse.status,
      headers: responseHeaders,
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildGatewayUrl(env: Env, pathname: string): string {
  const base = `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_GATEWAY_ID}`;
  return `${base}${pathname}`;
}

function extractInputText(body: Record<string, unknown>): string {
  // OpenAI-compatible: messages array
  const messages = body.messages as Array<{ role: string; content: string }> | undefined;
  if (messages) {
    const userMessages = messages
      .filter((m) => m.role === "user")
      .map((m) => m.content);
    return userMessages.join("\n");
  }
  // Anthropic style: prompt field
  if (typeof body.prompt === "string") return body.prompt;
  return "";
}

function extractContextText(body: Record<string, unknown>): string | null {
  // Check for system message with context
  const messages = body.messages as Array<{ role: string; content: string }> | undefined;
  if (messages) {
    const systemMsg = messages.find((m) => m.role === "system");
    if (systemMsg?.content && systemMsg.content.includes("Context:")) {
      return systemMsg.content;
    }
  }
  return null;
}

function extractOutputText(response: GatewayResponse): string {
  // OpenAI-compatible
  if (response.choices?.[0]?.message?.content) {
    return response.choices[0].message.content;
  }
  // Anthropic
  if (Array.isArray(response.content) && response.content[0]?.text) {
    return response.content[0].text;
  }
  return "";
}

function extractModelName(body: Record<string, unknown>): string {
  return (body.model as string) || "unknown";
}

function extractProvider(pathname: string): string {
  if (pathname.includes("openai")) return "openai";
  if (pathname.includes("anthropic")) return "anthropic";
  if (pathname.includes("google")) return "google";
  return "unknown";
}

async function postToCert(
  apiKey: string,
  dashboardUrl: string,
  payload: CertTracePayload
): Promise<void> {
  const url = `${dashboardUrl.replace(/\/$/, "")}/api/v1/traces`;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Non-fatal — gateway operation is unaffected by CERT logging failure
    console.error("CERT trace POST failed:", err);
  }
}
