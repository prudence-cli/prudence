// Batch client (N2): submit queued payloads, poll, fetch results.
// Two implementations: AnthropicBatchClient (real API shape, live only —
// never used in tests) and MockBatchClient (scripted, tests + demo).

export type BatchPayloadParams = {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: "user"; content: string }[];
};

export type BatchSubmitResult = { batch_id: string };
export type BatchPollResult =
  | { state: "submitted" | "processing" }
  | { state: "ended"; results_text: string };

export interface BatchClient {
  submit(customId: string, params: BatchPayloadParams): Promise<BatchSubmitResult>;
  poll(batchId: string): Promise<BatchPollResult>;
}

// Anthropic Message Batches API, 50% off, 24h SLA. Live only.
export class AnthropicBatchClient implements BatchClient {
  private baseUrl: string;
  private apiKey: string;
  private version: string;

  constructor(opts?: { baseUrl?: string; apiKey?: string; version?: string }) {
    this.baseUrl = opts?.baseUrl ?? "https://api.anthropic.com";
    const key = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.PRU_UPSTREAM_API_KEY;
    if (!key) {
      throw new Error("Pru needs ANTHROPIC_API_KEY to submit night batches.");
    }
    this.apiKey = key;
    this.version = opts?.version ?? "2023-06-01";
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": this.version,
    };
  }

  async submit(customId: string, params: BatchPayloadParams): Promise<BatchSubmitResult> {
    const res = await fetch(`${this.baseUrl}/v1/messages/batches`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ requests: [{ custom_id: customId, params }] }),
    });
    if (!res.ok) throw new Error(`Pru batch submit failed: HTTP ${res.status}.`);
    const body = (await res.json()) as { id?: string };
    if (!body.id) throw new Error("Pru batch submit returned no batch id.");
    return { batch_id: body.id };
  }

  async poll(batchId: string): Promise<BatchPollResult> {
    const res = await fetch(`${this.baseUrl}/v1/messages/batches/${batchId}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Pru batch poll failed: HTTP ${res.status}.`);
    const body = (await res.json()) as { processing_status?: string; results_url?: string };
    if (body.processing_status !== "ended" || !body.results_url) {
      return { state: "processing" };
    }
    const results = await fetch(body.results_url, { headers: this.headers() });
    if (!results.ok) throw new Error(`Pru batch results fetch failed: HTTP ${results.status}.`);
    return { state: "ended", results_text: await results.text() };
  }
}

// Scripted mock: submit returns an id, poll ends immediately with the canned
// diff wrapped in real result-JSONL shape. One mock per scenario.
export class MockBatchClient implements BatchClient {
  private diffByCustomId = new Map<string, string>();
  private cannedDiff: string;
  private n = 0;

  constructor(cannedDiff: string) {
    this.cannedDiff = cannedDiff;
  }

  async submit(customId: string, _params: BatchPayloadParams): Promise<BatchSubmitResult> {
    this.n += 1;
    this.diffByCustomId.set(customId, this.cannedDiff);
    return { batch_id: `mock_batch_${this.n}` };
  }

  async poll(_batchId: string): Promise<BatchPollResult> {
    const lines = [...this.diffByCustomId.entries()].map(([cid, diff]) =>
      JSON.stringify({
        custom_id: cid,
        result: {
          type: "succeeded",
          message: { content: [{ type: "text", text: diff }] },
        },
      }),
    );
    return { state: "ended", results_text: lines.join("\n") };
  }
}

// Pull the diff text for one job out of result JSONL. Strict: exactly one
// matching line, exactly one text block — anything else is a failed result,
// never a guess.
export function extractDiffForJob(resultsText: string, customId: string): string | null {
  const matches: string[] = [];
  for (const line of resultsText.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let row: unknown;
    try {
      row = JSON.parse(t);
    } catch {
      return null;
    }
    if ((row as { custom_id?: unknown }).custom_id !== customId) continue;
    const result = (row as { result?: unknown }).result as
      | { type?: unknown; message?: { content?: unknown } }
      | undefined;
    if (!result || result.type !== "succeeded") return null;
    const content = result.message?.content;
    if (!Array.isArray(content) || content.length !== 1) return null;
    const text = (content[0] as { text?: unknown }).text;
    if (typeof text !== "string") return null;
    matches.push(text);
  }
  return matches.length === 1 ? matches[0] : null;
}
