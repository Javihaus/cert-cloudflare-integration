export interface Env {
  // Required
  CF_ACCOUNT_ID: string;
  CF_GATEWAY_ID: string;
  CERT_API_KEY: string;

  // Optional
  CERT_DASHBOARD_URL: string;   // default: https://cert-framework.com
  CERT_PROJECT: string;         // default: cloudflare-gateway
}

export interface CertTrace {
  trace_id: string;
  name: string;
  llm_vendor: string;
  model: string;
  input_text: string;
  output_text: string;
  knowledge_base?: string;
  evaluation_mode: "grounded" | "ungrounded";
  duration_ms: number;
  source: string;
  project_name: string;
  timestamp: string;
}

export interface CertTracePayload {
  traces: CertTrace[];
}

export interface GatewayResponse {
  // OpenAI-compatible
  choices?: Array<{
    message?: { content: string; role: string };
    text?: string;
  }>;
  // Anthropic-compatible
  content?: Array<{ type: string; text: string }>;
  // Common
  model?: string;
  usage?: Record<string, number>;
}
