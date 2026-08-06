/**
 * GeminiProvider for the compute service's report generation (TASK A8 / F1).
 *
 * Implements the SAME `AIProvider` contract as `provider.ts` (the Anthropic impl
 * stays intact, selectable via `AI_PROVIDER=anthropic`). This is the DEFAULT
 * provider. The API key is read ONLY server-side (`GEMINI_API_KEY`,
 * `process.env`); it is never shipped to the device.
 *
 * Mapping onto Gemini (Generative Language API):
 *   - system          → `system_instruction: { parts: [{ text }] }`
 *   - ProviderMessage → `contents` ('assistant' role → 'model')
 *   - 'text' block        → `{ text }`
 *   - 'tool_use' block    → `{ functionCall: { name, args } }`
 *   - 'tool_result' block → `{ functionResponse: { name, response } }`
 *       (Gemini matches by NAME, not id; we encode the name into a synthetic id
 *        so the Anthropic-shaped report tool loop in `reportInterpreter.ts`
 *        round-trips unchanged.)
 *   - ToolSpec[]      → `tools: [{ functionDeclarations }]`
 *   - response functionCall parts → stopReason 'tool_use'; else concat text.
 *
 * The report's grounding, fact tools, and claim validation live in
 * `reportInterpreter.ts` and are provider-agnostic — only the wire format
 * changes here.
 */
import type {
  AIProvider,
  ChatRequest,
  ChatResult,
  ContentBlock,
  ProviderMessage,
  StopReason,
  ToolSpec,
} from './provider.js';
import { getVertexAccessToken } from './vertexAuth.js';

/** Default Gemini model for reports. `gemini-2.5-pro` favors quality. */
export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-pro' as const;

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';

/**
 * How a request is addressed + authenticated. Both backends share the SAME
 * `generateContent` body:
 *   - `studio` — AI Studio (Generative Language API), `x-goog-api-key`.
 *   - `vertex` — Vertex AI, `Authorization: Bearer <service-account token>`,
 *                billed through Google Cloud (where the $300 credit applies).
 */
export interface GeminiTransport {
  /** Full `generateContent` URL for a given model id. */
  buildUrl(model: string): string;
  /** Auth headers for the request (async — Vertex mints/refreshes a token). */
  authHeaders(): Promise<Record<string, string>>;
}

/** AI Studio transport — API key in `x-goog-api-key`. */
function studioTransport(apiKey: string): GeminiTransport {
  return {
    buildUrl: (model) => `${GEMINI_BASE_URL}/v1beta/models/${model}:generateContent`,
    authHeaders: async () => ({ 'x-goog-api-key': apiKey }),
  };
}

/** Vertex AI transport — regional endpoint + OAuth bearer from a service account. */
function vertexTransport(project: string, location: string): GeminiTransport {
  const prefix = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models`;
  return {
    buildUrl: (model) => `${prefix}/${model}:generateContent`,
    authHeaders: async () => ({ Authorization: `Bearer ${await getVertexAccessToken()}` }),
  };
}

const TOOL_ID_PREFIX = 'gemini-fn:';

export function synthToolId(name: string): string {
  return `${TOOL_ID_PREFIX}${name}`;
}

export function toolNameFromId(id: string): string {
  return id.startsWith(TOOL_ID_PREFIX) ? id.slice(TOOL_ID_PREFIX.length) : id;
}

export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GeminiRequestBody {
  system_instruction?: { parts: Array<{ text: string }> };
  contents: GeminiContent[];
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;
  generationConfig?: { maxOutputTokens?: number };
}

interface GeminiCandidate {
  content?: { role?: string; parts?: GeminiPart[] };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
}

function geminiRole(role: ProviderMessage['role']): 'user' | 'model' {
  return role === 'assistant' ? 'model' : 'user';
}

function blockToPart(block: ContentBlock): GeminiPart {
  switch (block.type) {
    case 'text':
      return { text: block.text };
    case 'tool_use':
      return { functionCall: { name: block.name, args: block.input } };
    case 'tool_result': {
      const name = toolNameFromId(block.tool_use_id);
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.content);
      } catch {
        parsed = block.content;
      }
      const response =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { result: parsed };
      return { functionResponse: { name, response } };
    }
  }
}

function messageToContent(message: ProviderMessage): GeminiContent {
  const role = geminiRole(message.role);
  if (typeof message.content === 'string') {
    return { role, parts: [{ text: message.content }] };
  }
  return { role, parts: message.content.map(blockToPart) };
}

export function toFunctionDeclarations(tools: ToolSpec[]): GeminiFunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));
}

/** Build the Gemini `generateContent` body for a chat request. Pure + testable. */
export function buildChatBody(req: ChatRequest): GeminiRequestBody {
  const body: GeminiRequestBody = {
    system_instruction: { parts: [{ text: req.system }] },
    contents: req.messages.map(messageToContent),
  };
  if (req.tools && req.tools.length > 0) {
    body.tools = [{ functionDeclarations: toFunctionDeclarations(req.tools) }];
  }
  // Mirror the Anthropic provider's `max_tokens`: without this, Gemini falls back
  // to its own (smaller) default output cap, truncating long single-call outputs
  // like the 13-section annual report (finishReason MAX_TOKENS) with no warning.
  if (typeof req.maxTokens === 'number') {
    body.generationConfig = { maxOutputTokens: req.maxTokens };
  }
  return body;
}

function mapFinishReason(raw: string | undefined): StopReason {
  switch (raw) {
    case 'STOP':
      return 'end_turn';
    case 'MAX_TOKENS':
      return 'max_tokens';
    default:
      return 'other';
  }
}

/** Parse a Gemini response into the provider-agnostic ChatResult. Pure + testable. */
export function parseChatResponse(payload: GeminiResponse): ChatResult {
  const candidate = payload.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  const toolBlocks: ContentBlock[] = [];
  const textChunks: string[] = [];
  for (const part of parts) {
    if (part.functionCall && typeof part.functionCall.name === 'string') {
      toolBlocks.push({
        type: 'tool_use',
        id: synthToolId(part.functionCall.name),
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      });
    } else if (typeof part.text === 'string') {
      textChunks.push(part.text);
    }
  }

  if (toolBlocks.length > 0) {
    return { content: toolBlocks, stopReason: 'tool_use' };
  }

  const text = textChunks.join('');
  return {
    content: text.length > 0 ? [{ type: 'text', text }] : [],
    stopReason: mapFinishReason(candidate?.finishReason),
  };
}

const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 800;
const MAX_BACKOFF_MS = 20_000;
/** Cap for an EXPLICIT server-suggested retryDelay (per-minute limits ask ~30-60s). */
const MAX_RETRY_DELAY_MS = 65_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter (ms). */
function backoffMs(attempt: number): number {
  const exp = BASE_BACKOFF_MS * 2 ** attempt;
  return Math.min(exp + Math.random() * BASE_BACKOFF_MS, MAX_BACKOFF_MS);
}

/** Gemini may return a suggested retry delay ("retryDelay":"20s"); honour it. */
function parseRetryDelayMs(detail: string): number | null {
  const m = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(detail);
  return m ? Math.ceil(parseFloat(m[1]!) * 1000) : null;
}

/**
 * A per-DAY free-tier quota does NOT clear by retrying (resets at midnight PT) —
 * only switching to a different model (separate daily bucket) helps.
 */
function isDailyQuota(detail: string): boolean {
  return /PerDay/i.test(detail);
}

/** Error carrying the HTTP status + whether falling through to another model may help. */
export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** True when another model might succeed (overload / exhausted / transient). */
    readonly tryNextModel: boolean,
    /**
     * True when this 429 is a PER-DAY quota (resets at midnight PT), NOT a
     * transient per-minute throttle. The provider uses this internally to skip
     * retrying the model; it is also propagated OUT (via {@link isDailyQuotaError})
     * so the route can tell the client "daily AI limit reached — resets tomorrow"
     * rather than "try again in a moment".
     */
    readonly dailyQuota = false,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

/**
 * Whether an error thrown out of the provider is a PER-DAY quota exhaustion (vs a
 * transient per-minute 429 / 503). Routes use this to surface a distinct
 * "resets tomorrow" message. When EVERY model's daily bucket is exhausted, the
 * provider's `chat()` rethrows the LAST error — itself a daily-quota GeminiError —
 * so this stays true through the model-fallback loop.
 */
export function isDailyQuotaError(err: unknown): boolean {
  return err instanceof GeminiError && err.dailyQuota;
}

export class GeminiProvider implements AIProvider {
  readonly model: string;
  /** Models to fall through to when the primary is rate-limited/overloaded. */
  private readonly fallbacks: string[];
  /** URL + auth strategy (AI Studio by default, or Vertex via `vertex()`). */
  private readonly transport: GeminiTransport;

  constructor(apiKey: string, model?: string, transport?: GeminiTransport) {
    if (!transport && !apiKey) throw new Error('GeminiProvider requires an API key.');
    this.model = model ?? GEMINI_DEFAULT_MODEL;
    this.transport = transport ?? studioTransport(apiKey);
    // Each free-tier model has its OWN daily bucket, so a fallback ~doubles
    // capacity AND routes around a single model being momentarily overloaded.
    const env = process.env.GEMINI_MODEL_FALLBACK ?? 'gemini-2.5-flash,gemini-2.5-flash-lite';
    this.fallbacks = env
      .split(',')
      .map((s) => s.trim())
      .filter((m) => m.length > 0 && m !== this.model);
  }

  /**
   * Build a Vertex-AI-backed provider: same Gemini body, but the regional
   * Vertex endpoint + service-account OAuth (so the $300 GCP credit applies).
   */
  static vertex(opts: { project: string; location: string; model?: string }): GeminiProvider {
    return new GeminiProvider('', opts.model, vertexTransport(opts.project, opts.location));
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const models = [this.model, ...this.fallbacks];
    let lastError: unknown;
    for (const model of models) {
      try {
        return await this.callWithRetry(model, req);
      } catch (err) {
        lastError = err;
        // A hard error (bad request, auth, etc.) won't be fixed by another
        // model — surface it immediately. Otherwise try the next model.
        if (err instanceof GeminiError && !err.tryNextModel) throw err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Gemini request failed');
  }

  /** One model, retrying transient overload/rate-limit with backoff. */
  private async callWithRetry(model: string, req: ChatRequest): Promise<ChatResult> {
    const body = JSON.stringify(buildChatBody(req));
    const url = this.transport.buildUrl(model);

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        const authHeaders = await this.transport.authHeaders();
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders },
          body,
        });
      } catch (e) {
        // Network blip — retry, then let another model try.
        if (attempt >= MAX_RETRIES) {
          throw new GeminiError(`Gemini network error: ${String(e)}`, 0, true);
        }
        await sleep(backoffMs(attempt));
        continue;
      }

      if (res.ok) return parseChatResponse((await res.json()) as GeminiResponse);

      const detail = await res.text().catch(() => '');
      const status = res.status;

      // Daily quota exhausted on this model → don't retry it, try the next model.
      // Tag it `dailyQuota` so that if EVERY model's daily bucket is exhausted the
      // final rethrown error still carries the per-day distinction out to the route.
      if (status === 429 && isDailyQuota(detail)) {
        throw new GeminiError(`Gemini API ${status} (daily quota): ${detail}`, status, true, true);
      }
      // Transient: per-minute 429, 503 overloaded, 500. Retry with backoff.
      const transient = status === 503 || status === 500 || status === 429;
      if (!transient) {
        // 400/401/403/404 — a different model won't help; surface it.
        throw new GeminiError(`Gemini API ${status}: ${detail}`, status, false);
      }
      if (attempt >= MAX_RETRIES) {
        throw new GeminiError(
          `Gemini API ${status} after ${attempt + 1} attempts: ${detail}`,
          status,
          true,
        );
      }
      // Honour an explicit server retryDelay in full (capped at ~65s); otherwise
      // use bounded exponential backoff.
      const explicit = parseRetryDelayMs(detail);
      await sleep(
        explicit != null ? Math.min(explicit + 500, MAX_RETRY_DELAY_MS) : backoffMs(attempt),
      );
    }
  }
}
