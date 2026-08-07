/**
 * Server-side AIProvider for the compute service's report generation (TASK A8).
 *
 * Same provider-agnostic contract as the Edge Function (`AIProvider`), with an
 * Anthropic implementation against the Messages API. Provider swap is a one-line
 * change in `createProvider`; the model id lives in `ANTHROPIC_MODEL`.
 *
 * The API key is read ONLY here, server-side; it is never shipped to the device.
 *
 * As of F1 the DEFAULT provider is Google Gemini (`gemini-provider.ts`); the
 * Anthropic impl below is kept intact and selectable via `AI_PROVIDER=anthropic`.
 */
import { GeminiProvider, GEMINI_DEFAULT_MODEL } from './gemini-provider.js';

/** A tool the model may call (Messages API `tools` shape). */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export type StopReason = 'tool_use' | 'end_turn' | 'max_tokens' | 'stop_sequence' | 'other';

export interface ChatResult {
  content: ContentBlock[];
  stopReason: StopReason;
}

export interface ChatRequest {
  system: string;
  messages: ProviderMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
}

export interface AIProvider {
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatResult>;
}

/**
 * Per-tier model ids. `/interpret` serves cheap one-off placement bodies and the
 * conversational astrologer through the same path; `/report` is the premium PDF
 * deep-dive. Each is overridable by an env var so the mapping can be tuned
 * without a redeploy.
 *
 *   interpretation → Haiku   chat → Sonnet   report → Opus
 */
export const ANTHROPIC_TIER_MODELS = {
  interpretation: 'claude-haiku-4-5',
  chat: 'claude-sonnet-5',
  report: 'claude-opus-5',
} as const;

export type AnthropicTier = keyof typeof ANTHROPIC_TIER_MODELS;

const TIER_ENV: Record<AnthropicTier, string> = {
  interpretation: 'ANTHROPIC_MODEL_INTERPRETATION',
  chat: 'ANTHROPIC_MODEL_CHAT',
  report: 'ANTHROPIC_MODEL_REPORT',
};

/** Resolve the Anthropic model id for a tier (env override → built-in default). */
function anthropicModelFor(tier: AnthropicTier): string {
  return process.env[TIER_ENV[tier]] || ANTHROPIC_TIER_MODELS[tier];
}

/** Back-compat default model id (the premium tier). */
export const ANTHROPIC_MODEL = ANTHROPIC_TIER_MODELS.report;

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function mapStopReason(raw: string | undefined): StopReason {
  switch (raw) {
    case 'tool_use':
      return 'tool_use';
    case 'end_turn':
      return 'end_turn';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    default:
      return 'other';
  }
}

function toAnthropic(content: string | ContentBlock[]): unknown {
  if (typeof content === 'string') return content;
  return content.map((block) => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'tool_use':
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: block.content,
          ...(block.is_error ? { is_error: true } : {}),
        };
    }
  });
}

function fromAnthropic(content: AnthropicBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use' && block.id && block.name) {
      out.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} });
    }
  }
  return out;
}

class AnthropicProvider implements AIProvider {
  readonly model: string;
  /** Haiku 4.5 has no adaptive thinking — only enable it for Sonnet/Opus. */
  private readonly useThinking: boolean;

  constructor(
    private readonly apiKey: string,
    model: string = ANTHROPIC_TIER_MODELS.report,
  ) {
    this.model = model;
    this.useThinking = !model.startsWith('claude-haiku');
  }

  /**
   * System prompt as a cache-controlled block. The stable prefix (instructions +
   * deterministic chart ground truth) is large and repeats across turns, so
   * caching it bills the prefix at ~0.1× after the first call; volatile content
   * stays in `messages`, after the breakpoint.
   */
  private systemBlocks(system: string): unknown {
    return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body = {
      model: this.model,
      max_tokens: req.maxTokens ?? 4096,
      system: this.systemBlocks(req.system),
      messages: req.messages.map((m) => ({ role: m.role, content: toAnthropic(m.content) })),
      ...(req.tools ? { tools: req.tools } : {}),
      // Sonnet/Opus: adaptive thinking only. Haiku: omit (unsupported).
      ...(this.useThinking ? { thinking: { type: 'adaptive' } } : {}),
    };
    const res = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Anthropic API ${res.status}: ${detail}`);
    }
    const payload = (await res.json()) as { content?: AnthropicBlock[]; stop_reason?: string };
    return {
      content: fromAnthropic(payload.content ?? []),
      stopReason: mapStopReason(payload.stop_reason),
    };
  }
}

/**
 * Build the runtime provider (the ONE swap point). The DEFAULT is Google Gemini;
 * Anthropic Claude is kept intact and selectable via `AI_PROVIDER=anthropic`, so
 * reverting is a ONE-ENV-VAR change (no code edit).
 *
 *   AI_PROVIDER=gemini      (default) → GeminiProvider     (GEMINI_API_KEY)
 *   AI_PROVIDER=anthropic             → AnthropicProvider  (ANTHROPIC_API_KEY)
 *
 * `tier` ONLY selects a per-tier model on Anthropic (interpretation/chat/report →
 * Haiku/Sonnet/Opus). It is IGNORED for the default Gemini/Vertex backends: every
 * tier uses the same `GEMINI_MODEL` (a single model, overridable by env), so do
 * NOT assume premium reports run on a better Gemini model than chat — they don't.
 *
 * API keys are read ONLY here (server-side); never shipped to the device.
 */
export function createProvider(tier: AnthropicTier = 'chat'): AIProvider {
  const which = (process.env.AI_PROVIDER ?? 'gemini').toLowerCase();

  if (which === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured.');
    return new AnthropicProvider(apiKey, anthropicModelFor(tier));
  }

  // Gemini on Vertex AI (service-account auth; the $300 GCP credit applies).
  if (which === 'vertex') {
    const project = process.env.GOOGLE_VERTEX_PROJECT;
    const location = process.env.GOOGLE_VERTEX_LOCATION || 'us-central1';
    if (!project) throw new Error('GOOGLE_VERTEX_PROJECT is not configured.');
    const model = process.env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL;
    return GeminiProvider.vertex({ project, location, model });
  }

  // Default: Gemini on AI Studio (API key).
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured.');
  const model = process.env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL;
  return new GeminiProvider(apiKey, model);
}
