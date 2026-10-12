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
 * Register the last-resort Workers AI leg. Call once per isolate from a Worker
 * entry point; see workersAiRunnerFromBinding(). Pass null to remove it.
 * Outside a Worker nothing is registered and the chain is unchanged.
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
/** OpenAI-format function tool. */
export interface ToolDefinition {
    type: "function";
    function: {
        name: string;
        description?: string;
        /** JSON Schema for the arguments object. */
        parameters?: Record<string, unknown>;
    };
}
/** A tool call the model made, normalized across providers. */
export interface ToolCall {
    /** Provider call id; send it back as `toolCallId` on the result. */
    id: string;
    name: string;
    /** Parsed arguments ({} when the model sent none or unparseable JSON). */
    arguments: Record<string, unknown>;
}
export type ToolChatMessage = {
    role: "user";
    content: string;
} | {
    role: "assistant";
    content: string;
    toolCalls?: ToolCall[];
} | {
    role: "tool";
    toolCallId: string;
    content: string;
    isError?: boolean;
};
/** One part of a multi-part system prompt. `cache_control` marks a prompt-cache
 *  breakpoint on the Anthropic leg; OpenAI-shape legs join the parts' text. */
export interface SystemPart {
    text: string;
    cache_control?: {
        type: "ephemeral";
    };
}
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type FinishReason = "stop" | "tool_calls" | "length" | "other";
export interface ToolChatArgs {
    /** A string, or parts (e.g. a cached stable block and a volatile tail). */
    system: string | SystemPart[];
    messages: ToolChatMessage[];
    /** Function tools the model may call. Omit or [] for a text-only turn. */
    tools?: ToolDefinition[];
    /** "auto" (default) or "none". Forcing a tool is not offered: OCP refuses it. */
    toolChoice?: "auto" | "none";
    model?: string;
    tier?: ModelTier;
    /** Defaults to 8192. */
    maxTokens?: number;
    temperature?: number;
    /** OCP legs: `reasoning_effort`. Anthropic leg: `output_config.effort`. */
    effort?: ReasoningEffort;
    /** Extra request fields sent on the Anthropic leg only (e.g. `thinking`). */
    anthropic?: Record<string, unknown>;
    /** Aborts the in-flight request. An aborted call never fails over. */
    signal?: AbortSignal;
}
export interface ToolChatResult extends ChatResult {
    toolCalls: ToolCall[];
    finishReason: FinishReason;
    /** The model id the answering leg ran. */
    model: string;
}
export type ChatStreamEvent = {
    type: "start";
    provider: Provider;
    model: string;
} | {
    type: "text";
    text: string;
} | {
    type: "tool_call_start";
    index: number;
    id: string;
    name: string;
} | {
    type: "tool_call";
    call: ToolCall;
} | {
    type: "done";
    result: ToolChatResult;
};
/** Convert Anthropic-format tools (`{ name, description, input_schema }`) to
 *  OpenAI function tools, for callers migrating from the Anthropic SDK. */
export declare function toolsFromAnthropic(tools: ReadonlyArray<{
    name: string;
    description?: string;
    input_schema?: unknown;
}>): ToolDefinition[];
/**
 * Stream one model turn with optional function tools. Yields `start`
 * (provider + model), `text` deltas, `tool_call_start`, `tool_call` and a
 * final `done` carrying the full `ToolChatResult`. Fails over to the next leg
 * only before the first event; after that an error is thrown.
 */
export declare function chatStream(args: ToolChatArgs): AsyncGenerator<ChatStreamEvent>;
/**
 * One model turn with optional function tools, not streamed to the caller.
 * Returns the text, normalized tool calls and finish reason. Fails over to the
 * next leg on any error, mid-response included.
 */
export declare function chatTools(args: ToolChatArgs): Promise<ToolChatResult>;
//# sourceMappingURL=llm.d.ts.map