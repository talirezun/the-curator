/**
 * LLM abstraction layer — supports Anthropic Claude and Google Gemini.
 *
 * Provider selection (automatic, based on which key is set in .env):
 *   GEMINI_API_KEY      → Google Gemini  (default model: gemini-2.5-flash-lite)
 *   ANTHROPIC_API_KEY   → Anthropic Claude (default model: claude-sonnet-4-6)
 *
 * Optional override:
 *   LLM_MODEL=<model-id>   override the default model for whichever provider is active
 */

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';

const DEFAULTS = {
  gemini: 'gemini-2.5-flash-lite',
  anthropic: 'claude-sonnet-4-6',
};

export function getProviderInfo() {
  if (process.env.GEMINI_API_KEY) {
    return {
      provider: 'gemini',
      model: process.env.LLM_MODEL || DEFAULTS.gemini,
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: 'anthropic',
      model: process.env.LLM_MODEL || DEFAULTS.anthropic,
    };
  }
  throw new Error(
    'No LLM API key found. Set GEMINI_API_KEY or ANTHROPIC_API_KEY in your .env file.'
  );
}

/**
 * Extract the retry-after delay in milliseconds from a 429 error.
 * The Gemini API embeds this in the error message as e.g. "retry in 27.136s"
 * or in a structured RetryInfo field.
 */
function parseRetryDelay(err) {
  const msg = err?.message ?? '';

  // Structured: "retryDelay":"27s" or "retryDelay": "27.136533819s"
  const structuredMatch = msg.match(/"retryDelay"\s*:\s*"([\d.]+)s"/);
  if (structuredMatch) return Math.ceil(parseFloat(structuredMatch[1]) * 1000);

  // Plain text: "Please retry in 27.136533819s"
  const plainMatch = msg.match(/retry in ([\d.]+)s/i);
  if (plainMatch) return Math.ceil(parseFloat(plainMatch[1]) * 1000);

  // Default fallback: 60 seconds
  return 60_000;
}

function is429(err) {
  const msg = err?.message ?? '';
  return msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('RESOURCE_EXHAUSTED');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Call the active LLM with a system prompt and user message.
 * Automatically retries on 429 rate-limit errors using the delay
 * specified by the API in the error response.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {number} maxTokens
 * @param {'text'|'json'} responseFormat - 'json' enables native JSON mode (Gemini only)
 * @returns {Promise<string>}
 */
export async function generateText(systemPrompt, userPrompt, maxTokens = 8192, responseFormat = 'text') {
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callLLM(systemPrompt, userPrompt, maxTokens, responseFormat);
    } catch (err) {
      if (is429(err) && attempt < MAX_RETRIES) {
        const delayMs = parseRetryDelay(err);
        const delaySec = Math.ceil(delayMs / 1000);
        console.warn(
          `[llm] Rate limit hit (attempt ${attempt}/${MAX_RETRIES}). ` +
          `Waiting ${delaySec}s before retrying...`
        );
        await sleep(delayMs);
        continue;
      }

      // Not a 429, or out of retries — throw a clean error
      if (is429(err)) {
        const delaySec = Math.ceil(parseRetryDelay(err) / 1000);
        throw new Error(
          `Rate limit reached: the Gemini free tier allows 20 requests per day. ` +
          `Please wait ${delaySec} seconds and try again, or upgrade your Gemini API plan at https://ai.dev/rate-limit`
        );
      }

      throw err;
    }
  }
}

async function callLLM(systemPrompt, userPrompt, maxTokens, responseFormat) {
  const { provider, model } = getProviderInfo();

  // ── Google Gemini ────────────────────────────────────────────────────────
  if (provider === 'gemini') {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const geminiModel = genAI.getGenerativeModel({
      model,
      systemInstruction: systemPrompt,
    });
    const generationConfig = { maxOutputTokens: maxTokens };
    if (responseFormat === 'json') {
      // Forces Gemini to output structurally valid JSON, preventing
      // unescaped markdown characters (backticks, quotes) from breaking parsing.
      generationConfig.responseMimeType = 'application/json';
    }
    const result = await geminiModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig,
    });
    return result.response.text();
  }

  // ── Anthropic Claude ─────────────────────────────────────────────────────
  const client = new Anthropic();
  const message = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  return message.content[0].text;
}
