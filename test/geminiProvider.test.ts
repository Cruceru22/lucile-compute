/**
 * Unit tests for the compute service's Gemini provider (F1) — PURE request
 * shaping + response parsing for the report tool loop. NO live Gemini call (key
 * blocked); we verify the wire mapping only, structured so a real call works
 * once the key is unblocked.
 */
import { describe, expect, it } from 'vitest';

import {
  buildChatBody,
  parseChatResponse,
  synthToolId,
  toFunctionDeclarations,
  toolNameFromId,
} from '../src/ai/gemini-provider.js';
import type { ChatRequest, ToolSpec } from '../src/ai/provider.js';

const TOOLS: ToolSpec[] = [
  {
    name: 'get_planet',
    description: 'placement',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
];

describe('buildChatBody (compute)', () => {
  it('maps system_instruction, roles, and functionDeclarations', () => {
    const req: ChatRequest = {
      system: 'report writer',
      messages: [
        { role: 'user', content: 'write core identity' },
        { role: 'assistant', content: 'ok' },
      ],
      tools: TOOLS,
    };
    const body = buildChatBody(req);
    expect(body.system_instruction).toEqual({ parts: [{ text: 'report writer' }] });
    expect(body.contents[0]?.role).toBe('user');
    expect(body.contents[1]?.role).toBe('model');
    expect(body.tools).toEqual([{ functionDeclarations: toFunctionDeclarations(TOOLS) }]);
  });

  it('sets generationConfig.maxOutputTokens from req.maxTokens (avoids silent truncation)', () => {
    const req: ChatRequest = {
      system: 's',
      messages: [{ role: 'user', content: 'write the annual report' }],
      maxTokens: 8192,
    };
    expect(buildChatBody(req).generationConfig).toEqual({ maxOutputTokens: 8192 });
  });

  it('omits generationConfig when maxTokens is not provided', () => {
    const body = buildChatBody({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(body.generationConfig).toBeUndefined();
  });

  it('round-trips a tool_use → functionCall and tool_result → functionResponse', () => {
    const req: ChatRequest = {
      system: 's',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: synthToolId('get_planet'),
              name: 'get_planet',
              input: { name: 'Sun' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: synthToolId('get_planet'),
              content: JSON.stringify({ sign: 'Leo' }),
            },
          ],
        },
      ],
    };
    const body = buildChatBody(req);
    expect(body.contents[0]?.parts[0]).toEqual({
      functionCall: { name: 'get_planet', args: { name: 'Sun' } },
    });
    expect(body.contents[1]?.parts[0]).toEqual({
      functionResponse: { name: 'get_planet', response: { sign: 'Leo' } },
    });
  });
});

describe('parseChatResponse (compute)', () => {
  it('concatenates text and reports end_turn', () => {
    const r = parseChatResponse({
      candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] }, finishReason: 'STOP' }],
    });
    expect(r.stopReason).toBe('end_turn');
    expect(r.content).toEqual([{ type: 'text', text: 'ab' }]);
  });

  it('maps a MAX_TOKENS finishReason to stopReason max_tokens', () => {
    const r = parseChatResponse({
      candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }],
    });
    expect(r.stopReason).toBe('max_tokens');
  });

  it('extracts a functionCall as a tool_use turn (loop continues)', () => {
    const r = parseChatResponse({
      candidates: [
        { content: { parts: [{ functionCall: { name: 'get_planet', args: { name: 'Sun' } } }] } },
      ],
    });
    expect(r.stopReason).toBe('tool_use');
    expect(r.content[0]).toEqual({
      type: 'tool_use',
      id: synthToolId('get_planet'),
      name: 'get_planet',
      input: { name: 'Sun' },
    });
  });
});

describe('synthetic id round-trip (compute)', () => {
  it('encodes and recovers the name', () => {
    expect(toolNameFromId(synthToolId('list_aspects'))).toBe('list_aspects');
  });
});
