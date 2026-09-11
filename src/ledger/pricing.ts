// Versioned price table + envelope-context estimator.
// Rates: USD per 1M tokens, sourced from official provider pricing
// (claude.com/pricing, developers.openai.com/api/docs/pricing,
// api-docs.deepseek.com). Compiled 2026-09-11. Unknown models return null —
// Pru never invents a number (truth: unknown_price).

export const PRICE_TABLE_SOURCE = "official_provider_pricing";
export const PRICE_TABLE_VERIFIED = "2026-09-11";
export const BATCH_DISCOUNT = 0.5;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
export const CHARS_PER_TOKEN = 4;

export type ModelRates = {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  provider: string;
  batch: boolean;
};

type PriceEntry = {
  match: string[];
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  provider: string;
};

const MODEL_PRICES: PriceEntry[] = [
  { match: ["claude-opus", "opus-4"], inputPerMillion: 5, outputPerMillion: 25, cacheReadPerMillion: 0.5, provider: "anthropic" },
  { match: ["claude-sonnet", "sonnet-4"], inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, provider: "anthropic" },
  { match: ["claude-haiku", "haiku-4"], inputPerMillion: 1, outputPerMillion: 5, cacheReadPerMillion: 0.1, provider: "anthropic" },
  { match: ["gpt-5.5"], inputPerMillion: 5, outputPerMillion: 30, cacheReadPerMillion: 0.5, provider: "openai" },
  { match: ["gpt-5.4-nano", "gpt-5-nano"], inputPerMillion: 0.2, outputPerMillion: 1.25, cacheReadPerMillion: 0.02, provider: "openai" },
  { match: ["gpt-5.4-mini", "gpt-5-mini"], inputPerMillion: 0.75, outputPerMillion: 4.5, cacheReadPerMillion: 0.075, provider: "openai" },
  { match: ["gpt-5.4", "gpt-5"], inputPerMillion: 2.5, outputPerMillion: 15, cacheReadPerMillion: 0.25, provider: "openai" },
  { match: ["gpt-4o-mini"], inputPerMillion: 0.15, outputPerMillion: 0.6, cacheReadPerMillion: 0.075, provider: "openai" },
  { match: ["gpt-4o"], inputPerMillion: 2.5, outputPerMillion: 10, cacheReadPerMillion: 1.25, provider: "openai" },
  { match: ["deepseek-v4-pro"], inputPerMillion: 0.435, outputPerMillion: 0.87, cacheReadPerMillion: 0.003625, provider: "deepseek" },
  { match: ["deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner", "deepseek"], inputPerMillion: 0.14, outputPerMillion: 0.28, cacheReadPerMillion: 0.0028, provider: "deepseek" },
];

export function modelPricing(model: string): ModelRates | null {
  const name = String(model ?? "").toLowerCase();
  const batch = name.includes("batch");
  for (const entry of MODEL_PRICES) {
    if (entry.match.some((m) => name.includes(m))) {
      return {
        inputPerMillion: entry.inputPerMillion,
        outputPerMillion: entry.outputPerMillion,
        cacheReadPerMillion: entry.cacheReadPerMillion,
        provider: entry.provider,
        batch,
        source: PRICE_TABLE_SOURCE,
        verified: PRICE_TABLE_VERIFIED,
      } as ModelRates;
    }
  }
  return null;
}

function applyBatch(rate: number, batch: boolean): number {
  return batch ? rate * BATCH_DISCOUNT : rate;
}

// Measure message text only — never the JSON envelope overhead. This is the
// core fix for Runcap's blind estimator (docs/runcap-study.md §2).
export function measureInputTokens(messageText: string): number {
  if (!messageText) return 1;
  return Math.max(1, Math.ceil(String(messageText).length / CHARS_PER_TOKEN));
}

export type Envelope = {
  session_id: string;
  stage?: string;
  spent_micro_usd: number;
  reserved_micro_usd: number;
  cap_micro_usd: number | null;
};

export type CallShape = {
  model: string;
  input_text: string;
  max_output_tokens?: number;
};

export type EstimateOk = {
  ok: true;
  cost_max_micro_usd: number;
  input_tokens_est: number;
  max_output_tokens: number;
  truth: "envelope_estimate";
};

export type EstimateUnknown = {
  ok: false;
  truth: "unknown_price";
  model: string;
};

// Integer math throughout: rates are per-1M, so
// micro-usd = tokens * rate exactly. No floats touch the ledger.
export function estimateCall(
  call: CallShape,
  _env: Envelope,
): EstimateOk | EstimateUnknown {
  const pricing = modelPricing(call.model);
  if (!pricing) return { ok: false, truth: "unknown_price", model: call.model };
  const inputTokens = measureInputTokens(call.input_text);
  const maxOut =
    Number.isFinite(call.max_output_tokens as number) &&
    (call.max_output_tokens as number) > 0
      ? Math.floor(call.max_output_tokens as number)
      : DEFAULT_MAX_OUTPUT_TOKENS;
  const costMax =
    inputTokens * applyBatch(pricing.inputPerMillion, pricing.batch) +
    maxOut * applyBatch(pricing.outputPerMillion, pricing.batch);
  return {
    ok: true,
    cost_max_micro_usd: Math.round(costMax),
    input_tokens_est: inputTokens,
    max_output_tokens: maxOut,
    truth: "envelope_estimate",
  };
}

export type UsageIn = {
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
};

export function actualCostMicro(usage: UsageIn, model: string): number | null {
  const pricing = modelPricing(model);
  if (!pricing) return null;
  const cached = Math.max(0, Math.floor(usage.cached_tokens ?? 0));
  const rawInput = Math.max(0, Math.floor(usage.input_tokens ?? 0));
  const fresh = Math.max(0, rawInput - cached);
  const output = Math.max(0, Math.floor(usage.output_tokens ?? 0));
  const micro =
    fresh * applyBatch(pricing.inputPerMillion, pricing.batch) +
    cached * applyBatch(pricing.cacheReadPerMillion, pricing.batch) +
    output * applyBatch(pricing.outputPerMillion, pricing.batch);
  return Math.round(micro);
}

// Graveyard estimates (N1): the same token counts priced both ways so the
// 50% math is exact, not a slogan. Explicit batch flag — no name hacks.
export function priceTokensMicro(
  inputTokens: number,
  outputTokens: number,
  model: string,
  batch: boolean,
): number | null {
  const pricing = modelPricing(model);
  if (!pricing) return null;
  const micro =
    Math.max(0, Math.floor(inputTokens)) * applyBatch(pricing.inputPerMillion, batch) +
    Math.max(0, Math.floor(outputTokens)) * applyBatch(pricing.outputPerMillion, batch);
  return Math.round(micro);
}
