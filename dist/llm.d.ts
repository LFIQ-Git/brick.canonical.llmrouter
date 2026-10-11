export type Provider = "ocp" | "ocp-fallback" | "anthropic" | "workers-ai";
export type ModelTier = "fast" | "balanced" | "deep";
/** Tier → model ID. One place to bump models family-wide. Keep IDs inside
 *  the OCP proxy allowlist. */
export declare const MODEL_TIERS: Record<ModelTier, string>;
/** Default model when neither `model` nor `tier` is given. */
export declare const DEFAULT_LLM_MODEL: string;
export declare function getProvider(): Provider;
export interface ChatMessage {
    role: "user" | "assistant";
    content: string;
}
export interface ChatArgs {
    /** System / instruction text. Cache hint applied on the Anthropic path. */
    system: string;
    /** Conversation messages — usually one user message; multi-turn supported. */
    messages: ChatMessage[];
    /** Explicit model ID. Wins over `tier`. */
    model?: string;
    /** Capability tier — resolved via MODEL_TIERS when `model` is absent. */
    tier?: ModelTier;
    /** Defaults to 8192. */
    maxTokens?: number;
    /** Sampling temperature — passed through to the provider when set. */
    temperature?: number;
}
/** Token counts, normalized across providers ("" when the provider omits them). */
export interface ChatUsage {
    input_tokens?: number;
    output_tokens?: number;
    /** Anthropic path only — tokens written to / read from the prompt cache. */
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}
/** Rich result — text plus the metadata callers occasionally need. */
export interface ChatResult {
    text: string;
    usage: ChatUsage;
    /** The unmodified provider response object. */
    raw: unknown;
    /** The provider that actually produced this answer (post-failover). */
    provider: Provider;
}
/** One provider call's normalized output (text + usage + raw response). */
export interface ProviderOutput {
    text: string;
    usage: ChatUsage;
    raw: unknown;
}
/** What a Workers AI runner receives. The model is chosen by the runner (or
 *  WORKERS_AI_MODEL), never the Claude model ID the caller asked for. */
export interface WorkersAiRequest {
    model: string;
    system: string;
    messages: ChatMessage[];
    maxTokens: number;
    temperature?: number;
}
export type WorkersAiRunner = (req: WorkersAiRequest) => Promise<ProviderOutput>;
/** Default backstop model: general-purpose, 262k context, on the Workers AI catalog. */
export declare const DEFAULT_WORKERS_AI_MODEL = "@cf/zai-org/glm-5.2";
/**
 * Register the last-resort Workers AI leg. Call once from a Worker entry point
 * with a function that calls `env.AI.run(...)`; see workersAiRunnerFromBinding().
 * Pass null to remove it. Has no effect outside a Worker unless a runner is set.
 */
export declare function setWorkersAiRunner(runner: WorkersAiRunner | null): void;
/** Minimal shape of a Workers AI binding (`env.AI`). */
export interface WorkersAiBinding {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
}
/**
 * Build a runner from a Workers AI binding. Handles both response shapes the
 * catalog returns: `{ response: string }` and OpenAI-style `{ choices: [...] }`.
 */
export declare function workersAiRunnerFromBinding(ai: WorkersAiBinding): WorkersAiRunner;
/**
 * Single round-trip chat. Returns the model's text ("" if none). For token
 * counts or the raw provider response, use `chatDetailed()`.
 */
export declare function chat(args: ChatArgs): Promise<string>;
/**
 * Like `chat()`, but returns the rich result — `{ text, usage, raw, provider }`.
 * Use when you need token counts, the raw response (e.g. stop_reason), or the
 * provider that actually answered after failover.
 */
export declare function chatDetailed(args: ChatArgs): Promise<ChatResult>;
export declare function chatWithRetry(args: ChatArgs): Promise<string>;
export declare function chatDetailedWithRetry(args: ChatArgs): Promise<ChatResult>;
export declare function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T>;
//# sourceMappingURL=llm.d.ts.map