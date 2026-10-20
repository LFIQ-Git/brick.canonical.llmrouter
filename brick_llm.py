"""brick_llm.py — CANONICAL BRICK LLM router (Layer 0), Python twin.

This is the Python port of the canonical TypeScript router `llm.ts` in this
same directory. It is a faithful behavioral twin: same providers, same
provider resolution, same model tiers, same failover + circuit breaker, same
retry policy, and the same one-line `llm.call` structured log per call.

The TypeScript master serves Next.js apps; this twin serves the family's
Python work (ETL jobs — e.g. the GDM extractor Cloud Run job). When `llm.ts`
changes, this file must change with it. Architecture + rollout tracker:
02-brick.intel/docs/llm-architecture.md.

Providers (resolved + failed over automatically):
  - "ocp"       — Win-PC OCP proxy, subscription-backed, $0/call. Primary
                  when OCP_BASE_URL is set and LLM_PROVIDER != "anthropic".
  - "anthropic" — Anthropic SDK directly with ANTHROPIC_API_KEY. Fallback,
                  and forced when LLM_PROVIDER=anthropic.

Four things every caller gets for free here:
  1. Automatic failover — if OCP errors transiently, the call retries on
     Anthropic (when ANTHROPIC_API_KEY exists). A circuit breaker skips a
     flapping proxy for a cooldown window.
  2. Model tiers — ask for "fast" | "balanced" | "deep" instead of pinning a
     model ID in every caller. Bump the map here, once.
  3. Observability — every call emits a structured `llm.call` log line
     (provider, model, tier, latency, ok) for spend/usage rollups.
  4. Two return shapes — `chat()` returns just the text; `chat_detailed()`
     returns a `ChatResult` (text, usage, raw, provider) for callers that need
     token counts, the raw provider response, or the provider that actually
     answered (post-failover).

No module may import `openai` / `anthropic` outside this file. The SDKs are
imported lazily inside the call functions so the pure-function helpers (and
their tests) work without the SDKs installed — mirroring the way `llm.ts`
lazily constructs its clients.

Install deps: ``pip install openai anthropic`` (see requirements.txt).

Env contract (same names as llm.ts; no ocp-fallback leg yet):
  OCP_BASE_URL, OCP_API_KEY, OCP_CF_ACCESS_CLIENT_ID,
  OCP_CF_ACCESS_CLIENT_SECRET, ANTHROPIC_API_KEY, LLM_PROVIDER,
  LLM_MODEL_FAST, LLM_MODEL_BALANCED, LLM_MODEL_DEEP, EXTRACTION_MODEL,
  LLM_USER_AGENT, LLM_OCP_TIMEOUT_MS, LLM_OCP_MAX_RETRIES,
  LLM_ANTHROPIC_TIMEOUT_MS, LLM_ANTHROPIC_MAX_RETRIES.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from typing import Tuple, Any, Awaitable, Callable, Dict, List, Literal, Optional, TypedDict, TypeVar

Provider = Literal["ocp", "anthropic"]
ModelTier = Literal["fast", "balanced", "deep"]


# ── model tiers ──────────────────────────────────────────────────────────
def _model_tiers() -> Dict[str, str]:
    """Tier -> model ID. One place to bump models family-wide. Keep IDs inside
    the OCP proxy allowlist.

    Resolved at call time (not import time) so env overrides set after import
    are still honored — matching the TS, which reads ``process.env`` lazily in
    practice via Node's live env object.
    """
    return {
        "fast": os.environ.get("LLM_MODEL_FAST", "claude-haiku-4-5"),
        "balanced": os.environ.get("LLM_MODEL_BALANCED", "claude-sonnet-5-5"),
        "deep": os.environ.get("LLM_MODEL_DEEP", "claude-sonnet-5-5"),
    }


# Snapshot kept for parity with the TS `export const MODEL_TIERS`. Prefer
# `_model_tiers()` internally so late env overrides are honored.
MODEL_TIERS: Dict[str, str] = _model_tiers()


def default_llm_model() -> str:
    """Default model when neither `model` nor `tier` is given."""
    return os.environ.get("EXTRACTION_MODEL") or _model_tiers()["balanced"]


# Snapshot for parity with the TS `export const DEFAULT_LLM_MODEL`.
DEFAULT_LLM_MODEL: str = default_llm_model()


def get_provider() -> Provider:
    """Resolve the primary provider from env, exactly as ``llm.ts`` does."""
    if os.environ.get("LLM_PROVIDER", "").lower() == "anthropic":
        return "anthropic"
    if os.environ.get("OCP_BASE_URL"):
        return "ocp"
    return "anthropic"


# ── per-leg timeouts + OCP headers ───────────────────────────────────────
# SDK defaults are a 10-minute timeout with 2 internal retries, so a hung
# Win-PC could hold a call ~30 minutes before failover. Same defaults as
# llm.ts: OCP 180 s / 1 retry; Anthropic keeps SDK defaults unless set.
OCP_TIMEOUT_MS_DEFAULT = 180_000
OCP_MAX_RETRIES_DEFAULT = 1


def _env_int(name: str) -> Optional[int]:
    """Non-negative integer from env, or None when unset or invalid."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    try:
        n = int(float(raw))
    except ValueError:
        return None
    return n if n >= 0 else None


def _ocp_client_options() -> Dict[str, Any]:
    """OpenAI-SDK kwargs for the OCP client (timeout in seconds)."""
    ms = _env_int("LLM_OCP_TIMEOUT_MS")
    retries = _env_int("LLM_OCP_MAX_RETRIES")
    return {
        "timeout": (ms if ms is not None else OCP_TIMEOUT_MS_DEFAULT) / 1000.0,
        "max_retries": retries if retries is not None else OCP_MAX_RETRIES_DEFAULT,
    }


def _anthropic_client_options() -> Dict[str, Any]:
    """Anthropic-SDK kwargs — only what env overrides; SDK defaults otherwise."""
    opts: Dict[str, Any] = {}
    ms = _env_int("LLM_ANTHROPIC_TIMEOUT_MS")
    retries = _env_int("LLM_ANTHROPIC_MAX_RETRIES")
    if ms is not None:
        opts["timeout"] = ms / 1000.0
    if retries is not None:
        opts["max_retries"] = retries
    return opts


def _ocp_default_headers() -> Dict[str, str]:
    """Headers OCP needs, matching llm.ts: a non-OpenAI User-Agent (the
    gateway blocks the SDK default) and the Cloudflare Access service-token
    pair (without it Access redirects to an SSO page)."""
    headers = {"User-Agent": os.environ.get("LLM_USER_AGENT", "brick-canonical-llm/0.1")}
    cf_id = os.environ.get("OCP_CF_ACCESS_CLIENT_ID")
    cf_secret = os.environ.get("OCP_CF_ACCESS_CLIENT_SECRET")
    if cf_id and cf_secret:
        headers["CF-Access-Client-Id"] = cf_id
        headers["CF-Access-Client-Secret"] = cf_secret
    return headers


# ── lazily-constructed SDK clients ───────────────────────────────────────
_oai: Any = None
_anthropic: Any = None


def _get_openai() -> Any:
    """Lazily construct (and memoize) the OpenAI-SDK client pointed at OCP."""
    global _oai
    if _oai is not None:
        return _oai
    api_key = os.environ.get("OCP_API_KEY", "ocp-no-key")
    base_url = os.environ.get("OCP_BASE_URL")
    if not base_url:
        raise RuntimeError(
            "OCP_BASE_URL not set — cannot route to OCP proxy. Set "
            "LLM_PROVIDER=anthropic to fall back to direct Anthropic API."
        )
    from openai import OpenAI  # lazy import — see module docstring

    _oai = OpenAI(
        api_key=api_key,
        base_url=base_url,
        default_headers=_ocp_default_headers(),
        **_ocp_client_options(),
    )
    return _oai


DEFAULT_AI_GATEWAY_URL = (
    "https://gateway.ai.cloudflare.com/v1/c16c7246ee0a89e6deafe19a74480c6a/default/anthropic"
)


def anthropic_configured() -> bool:
    """True when the paid Anthropic leg can run: through the AI Gateway, or directly with a key."""
    return bool((os.environ.get("AI_GATEWAY_TOKEN") or "").strip() or os.environ.get("ANTHROPIC_API_KEY"))


def _drop_api_key(request: Any) -> None:
    # The gateway uses the Anthropic key it stores only when the request carries none.
    request.headers.pop("x-api-key", None)


def _get_anthropic() -> Any:
    """Lazily construct (and memoize) the Anthropic-SDK client.

    With AI_GATEWAY_TOKEN set, calls go through the Cloudflare AI Gateway (twin
    of ``getAnthropic`` in llm.ts); otherwise directly with ANTHROPIC_API_KEY.
    """
    global _anthropic
    if _anthropic is not None:
        return _anthropic
    token = (os.environ.get("AI_GATEWAY_TOKEN") or "").strip()
    if token:
        import anthropic  # lazy import — see module docstring

        _anthropic = anthropic.Anthropic(
            api_key="gateway",
            base_url=(os.environ.get("AI_GATEWAY_URL") or DEFAULT_AI_GATEWAY_URL).strip(),
            default_headers={"cf-aig-authorization": f"Bearer {token}"},
            http_client=anthropic.DefaultHttpxClient(event_hooks={"request": [_drop_api_key]}),
            **_anthropic_client_options(),
        )
        return _anthropic
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY not set. Set OCP_BASE_URL to use the "
            "subscription proxy instead."
        )
    from anthropic import Anthropic  # lazy import — see module docstring

    _anthropic = Anthropic(api_key=api_key, **_anthropic_client_options())
    return _anthropic


# ── data shapes ──────────────────────────────────────────────────────────
class ChatMessage(TypedDict):
    """A single conversation message. ``role`` is "user" | "assistant"."""

    role: str
    content: str


@dataclass
class ChatArgs:
    """Arguments for one chat round-trip."""

    #: System / instruction text. Cache hint applied on the Anthropic path.
    system: str
    #: Conversation messages — usually one user message; multi-turn supported.
    messages: List[ChatMessage]
    #: Explicit model ID. Wins over ``tier``.
    model: Optional[str] = None
    #: Task key, app.task in lowercase ("keystone.triage"). Picks a per-task
    #: route and is what ai.runs records. Defaults to "<LLM_APP_NAME>.<tier>".
    task: Optional[str] = None
    #: Capability tier — resolved via MODEL_TIERS when ``model`` is absent.
    tier: Optional[ModelTier] = None
    #: Defaults to 8192.
    max_tokens: Optional[int] = None
    #: Sampling temperature — passed through to the provider when set.
    temperature: Optional[float] = None


class ChatUsage(TypedDict, total=False):
    """Token counts, normalized across providers (absent when omitted)."""

    input_tokens: int
    output_tokens: int
    # Anthropic path only — tokens written to / read from the prompt cache.
    cache_creation_input_tokens: int
    cache_read_input_tokens: int


@dataclass
class ChatResult:
    """Rich result — text plus the metadata callers occasionally need."""

    text: str
    usage: ChatUsage
    #: The unmodified provider response object.
    raw: Any
    #: The provider that actually produced this answer (post-failover).
    provider: Provider


# ── observability ────────────────────────────────────────────────────────
def _log_call(
    provider: Provider,
    model: str,
    tier: Optional[ModelTier],
    latency_ms: int,
    ok: bool,
    failed_over: Optional[bool] = None,
    err: Optional[str] = None,
    cache_write: Optional[int] = None,
    cache_read: Optional[int] = None,
) -> None:
    """Emit one structured ``llm.call`` line per call — cheap to grep / ship
    to a log drain later. Logging must never throw.
    """
    try:
        rec: Dict[str, Any] = {
            "provider": provider,
            "model": model,
            "latencyMs": latency_ms,
            "ok": ok,
        }
        # Match the TS JSON shape: optional keys appear only when set, and the
        # key order mirrors the TS record literal (provider, model, tier,
        # latencyMs, ok, failedOver, err, ts).
        if tier is not None:
            rec = {
                "provider": provider,
                "model": model,
                "tier": tier,
                "latencyMs": latency_ms,
                "ok": ok,
            }
        if failed_over is not None:
            rec["failedOver"] = failed_over
        if err is not None:
            rec["err"] = err
        if cache_write is not None:
            rec["cacheWrite"] = cache_write
        if cache_read is not None:
            rec["cacheRead"] = cache_read
        rec["ts"] = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + (
            ".%03dZ" % (int(time.time() * 1000) % 1000)
        )
        sys.stdout.write(f"llm.call {json.dumps(rec)}\n")
    except Exception:  # noqa: BLE001 — logging must never throw
        pass


# ── control plane: ai.routes / ai.runs on brickston-backend ─────────────
# Twin of the llm.ts block. With AI_CONTROL_URL + AI_CONTROL_SECRET set, routes
# come from GET /api/v1/ai/config?router=brick (cached 60 s) and every call is
# appended to ai.runs via POST /api/v1/ai/runs. A failure never fails a call.
ROUTE_TTL_S = 60.0
CONTROL_TIMEOUT_S = 2.0
_ctl: Dict[str, Any] = {"at": 0.0, "routes": None, "cap": None, "spent": None, "queue": []}


def _control() -> Optional[Tuple[str, Dict[str, str]]]:
    url = (os.environ.get("AI_CONTROL_URL") or "").strip().rstrip("/")
    secret = (os.environ.get("AI_CONTROL_SECRET") or "").strip()
    if not url or not secret:
        return None
    return url, {"x-scheduler-secret": secret, "content-type": "application/json"}


def _http_json(method: str, url: str, headers: Dict[str, str], body: Any = None) -> Any:
    import urllib.request

    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=CONTROL_TIMEOUT_S) as r:  # noqa: S310 — fixed backend URL
        raw = r.read()
        return json.loads(raw) if raw else None


def refresh_routes(force: bool = False) -> None:
    """Fetch the route table when the cached copy is older than 60 s. Never raises."""
    ctl = _control()
    if ctl is None:
        return
    if not force and time.time() - _ctl["at"] < ROUTE_TTL_S:
        return
    url, headers = ctl
    try:
        j = _http_json("GET", f"{url}/api/v1/ai/config?router=brick", headers)
        if isinstance(j, dict) and isinstance(j.get("routes"), list):
            _ctl["routes"] = j["routes"]
            _ctl["cap"] = float(j.get("daily_paid_cap_usd") or 0)
            _ctl["spent"] = float(j.get("today_paid_usd") or 0)
    except Exception:  # noqa: BLE001 — keep the previous table
        pass
    finally:
        _ctl["at"] = time.time()


def table_tier(tier: Optional[str]) -> str:
    """ai.routes tier for a router tier: balanced and standard are the same tier."""
    return tier if tier in ("fast", "deep") else "standard"


def _app_name() -> str:
    return re.sub(r"[^a-z0-9_]+", "_", (os.environ.get("LLM_APP_NAME") or "unknown").strip().lower())


def task_env_name(task: str) -> str:
    return "AI_ROUTE_" + re.sub(r"[^A-Z0-9]+", "_", task.upper())


def parse_route_override(spec: str) -> List[Dict[str, str]]:
    legs = []
    for part in spec.split(","):
        s = part.strip()
        provider, _, model = s.partition(":")
        if not provider or not model.strip():
            raise ValueError(f'bad route leg "{s}": use provider:model')
        if provider not in ("ocp", "anthropic"):
            raise ValueError(f'route provider "{provider}" is not allowed on the BRICK router (ocp or anthropic)')
        legs.append({"provider": provider, "model": model.strip()})
    return legs


def _legs_to_models(legs: List[Dict[str, str]]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for leg in legs:
        if leg.get("provider") == "ocp" and "ocp_model" not in out:
            out["ocp_model"] = leg["model"]
        if leg.get("provider") == "anthropic" and "anthropic_model" not in out:
            out["anthropic_model"] = leg["model"]
    return out


def resolve_route(task: Optional[str], tier: Optional[str], model: Optional[str]) -> Dict[str, Any]:
    """Models for one call: explicit model, AI_ROUTE_<TASK>, the ai.routes table, then MODEL_TIERS.
    Applies the daily paid cap to table routes (step down past 80%, hold at the cap)."""
    t = table_tier(tier)
    key = task or f"{_app_name()}.{t}"
    if model:
        return {"task": key, "tier": t, "ocp_model": model, "anthropic_model": model, "source": "model", "budget": "ok"}
    override = (os.environ.get(task_env_name(task)) or "").strip() if task else ""
    if override:
        return {"task": key, "tier": t, **_legs_to_models(parse_route_override(override)), "source": "override", "budget": "ok"}
    refresh_routes()
    routes = _ctl["routes"]
    if routes:
        route = next((r for r in routes if task and r.get("task") == task), None) or next(
            (r for r in routes if r.get("task") is None and r.get("tier") == t), None
        )
        if route:
            models = _legs_to_models([route["primary"]] + ([route["fallback"]] if route.get("fallback") else []))
            budget = "ok"
            cap, spent = _ctl["cap"] or 0.0, _ctl["spent"] or 0.0
            if cap > 0 and spent >= cap:
                budget = "held"
                models.pop("anthropic_model", None)
            elif cap > 0 and spent >= cap * 0.8 and route.get("tier") == "standard":
                fast = next((r for r in routes if r.get("task") is None and r.get("tier") == "fast"), None)
                paid = _legs_to_models([fast["primary"]] + ([fast["fallback"]] if fast.get("fallback") else [])).get("anthropic_model") if fast else None
                if paid:
                    budget = "step_down"
                    models["anthropic_model"] = paid
            return {"task": key, "tier": route.get("tier", t), **models, "source": "table", "budget": budget}
    m = _model_tiers()[tier] if tier else default_llm_model()  # type: ignore[index]
    return {"task": key, "tier": t, "ocp_model": m, "anthropic_model": m, "source": "builtin", "budget": "ok"}


def _enqueue_run(route: Dict[str, Any], provider: str, model: str, usage: Optional[ChatUsage],
                 latency_ms: int, ok: bool, failed_over: bool, err: Optional[str]) -> None:
    if _control() is None:
        return
    run: Dict[str, Any] = {
        "router": "brick", "app": route["task"].split(".")[0], "task": route["task"], "tier": route["tier"],
        "provider": provider, "model": model, "latency_ms": latency_ms, "fell_back": failed_over, "ok": ok,
    }
    if usage and usage.get("input_tokens") is not None:
        run["input_tokens"] = usage["input_tokens"]
    if usage and usage.get("output_tokens") is not None:
        run["output_tokens"] = usage["output_tokens"]
    if err:
        run["error"] = err[:300]
    q = _ctl["queue"]
    q.append(run)
    del q[:-500]


def flush_runs() -> None:
    """Send queued runs to ai.runs (2 s cap). Never raises."""
    ctl = _control()
    if ctl is None or not _ctl["queue"]:
        return
    url, headers = ctl
    batch = _ctl["queue"][:100]
    del _ctl["queue"][:100]
    try:
        _http_json("POST", f"{url}/api/v1/ai/runs", headers, {"runs": batch})
    except Exception:  # noqa: BLE001 — dropped; logging never fails a call
        pass


def anthropic_text_settings(model: str, max_tokens: int, temperature: Optional[float]) -> Dict[str, Any]:
    """Per-model settings (twin of anthropicTextSettings): thinking tokens count against max_tokens."""
    if model == "claude-sonnet-5-5":
        return {"max_tokens": max_tokens, "thinking": {"type": "between_tools"}}
    if re.match(r"^claude-(opus-5|fable-5|haiku-5)", model):
        return {"max_tokens": max_tokens + 4096, "output_config": {"effort": "low"}}
    out: Dict[str, Any] = {"max_tokens": max_tokens}
    if temperature is not None:
        out["temperature"] = temperature
    return out


# ── error redaction — nothing secret reaches a log line ──────────────────
_SECRET_ENV_NAMES = (
    "OCP_API_KEY",
    "OCP_CF_ACCESS_CLIENT_ID",
    "OCP_CF_ACCESS_CLIENT_SECRET",
    "OCP_FALLBACK_API_KEY",
    "ANTHROPIC_API_KEY",
    "AI_GATEWAY_TOKEN",
)
_ERR_MAX_CHARS = 300
_TOKEN_PATTERNS = (
    (re.compile(r"sk-[A-Za-z0-9_-]{8,}"), "[redacted]"),
    (re.compile(r"\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}", re.I), r"\1 [redacted]"),
    (
        re.compile(
            r"\b(api[_-]?key|x-api-key|cf-aig-authorization|authorization|cf-access-client-secret|cf-access-client-id)"
            r"([\"']?\s*[:=]\s*[\"']?)[^\s\"',}]{6,}",
            re.I,
        ),
        r"\1\2[redacted]",
    ),
)


def _redact_err(e: Any) -> str:
    """Error text safe to log, matching llm.ts ``redactErr``: configured
    secret values and token-shaped strings removed, whitespace collapsed,
    capped at 300 characters."""
    try:
        s = str(e)
        # Surface the network cause (e.g. ConnectError / errno) so a dead
        # leg is obvious in the log; SDK messages say only "Connection error.".
        cur = getattr(e, "__cause__", None)
        for _ in range(5):
            if cur is None:
                break
            label = type(cur).__name__
            if label not in s:
                s = f"{s} ({label}: {cur})"
                break
            cur = getattr(cur, "__cause__", None)
    except Exception:  # noqa: BLE001
        s = "[unprintable error]"
    for name in _SECRET_ENV_NAMES:
        v = os.environ.get(name)
        if v and len(v) >= 6:
            s = s.replace(v, "[redacted]")
    for pattern, replacement in _TOKEN_PATTERNS:
        s = pattern.sub(replacement, s)
    s = " ".join(s.split())
    return s if len(s) <= _ERR_MAX_CHARS else s[: _ERR_MAX_CHARS - 1] + "…"


# ── circuit breaker — skip a flapping OCP proxy for a cooldown ────────────
BREAKER_THRESHOLD = 3
BREAKER_COOLDOWN_MS = 60_000

_ocp_failures = 0
_ocp_opened_at = 0.0


def _now_ms() -> float:
    """Current wall-clock time in milliseconds (parity with JS Date.now())."""
    return time.time() * 1000.0


def _ocp_breaker_open() -> bool:
    """True when the OCP circuit breaker is open (skip OCP).

    Half-open behavior: once the cooldown window has elapsed the failure
    counter is reset so a single probe call is allowed through.
    """
    global _ocp_failures
    if _ocp_failures < BREAKER_THRESHOLD:
        return False
    if _now_ms() - _ocp_opened_at > BREAKER_COOLDOWN_MS:
        _ocp_failures = 0  # cooldown elapsed — half-open, allow a probe
        return False
    return True


def _note_ocp_result(ok: bool) -> None:
    """Record an OCP call outcome, tripping the breaker on repeated failure."""
    global _ocp_failures, _ocp_opened_at
    if ok:
        _ocp_failures = 0
    else:
        _ocp_failures += 1
        if _ocp_failures >= BREAKER_THRESHOLD:
            _ocp_opened_at = _now_ms()


def _resolve_model(args: ChatArgs) -> Dict[str, Optional[str]]:
    """Resolve the model ID + tier for a call (explicit model wins over tier)."""
    if args.model:
        return {"model": args.model, "tier": args.tier}
    if args.tier:
        return {"model": _model_tiers()[args.tier], "tier": args.tier}
    return {"model": default_llm_model(), "tier": None}


# ── provider calls ───────────────────────────────────────────────────────
@dataclass
class _ProviderOutput:
    """One provider call's normalized output (text + usage + raw response)."""

    text: str
    usage: ChatUsage
    raw: Any


def _call_ocp(
    system: str,
    messages: List[ChatMessage],
    model: str,
    max_tokens: int,
    temperature: Optional[float],
) -> _ProviderOutput:
    """Call the OCP proxy via the OpenAI Python SDK's chat-completions API."""
    oai = _get_openai()
    kwargs: Dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system},
            *({"role": m["role"], "content": m["content"]} for m in messages),
        ],
    }
    if temperature is not None:
        kwargs["temperature"] = temperature
    r = oai.chat.completions.create(**kwargs)
    choice = r.choices[0] if r.choices else None
    text = ""
    if choice is not None and choice.message is not None:
        text = choice.message.content or ""
    usage: ChatUsage = {}
    if r.usage is not None:
        if r.usage.prompt_tokens is not None:
            usage["input_tokens"] = r.usage.prompt_tokens
        if r.usage.completion_tokens is not None:
            usage["output_tokens"] = r.usage.completion_tokens
    return _ProviderOutput(text=text, usage=usage, raw=r)


def _call_anthropic(
    system: str,
    messages: List[ChatMessage],
    model: str,
    max_tokens: int,
    temperature: Optional[float],
) -> _ProviderOutput:
    """Call Anthropic directly via the Anthropic Python SDK's messages API.

    The system block is marked ``cache_control: ephemeral`` → 5-min
    prompt-cache hits (~90% input-token discount) when the system prefix
    repeats.
    """
    a = _get_anthropic()
    kwargs: Dict[str, Any] = {
        "model": model,
        **anthropic_text_settings(model, max_tokens, temperature),
        "system": [
            {"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}
        ],
        "messages": [{"role": m["role"], "content": m["content"]} for m in messages],
    }
    r = a.messages.create(**kwargs)
    block = next((b for b in r.content if getattr(b, "type", None) == "text"), None)
    text = block.text if block is not None and getattr(block, "type", None) == "text" else ""
    usage: ChatUsage = {}
    if r.usage is not None:
        if getattr(r.usage, "input_tokens", None) is not None:
            usage["input_tokens"] = r.usage.input_tokens
        if getattr(r.usage, "output_tokens", None) is not None:
            usage["output_tokens"] = r.usage.output_tokens
        if getattr(r.usage, "cache_creation_input_tokens", None) is not None:
            usage["cache_creation_input_tokens"] = r.usage.cache_creation_input_tokens
        if getattr(r.usage, "cache_read_input_tokens", None) is not None:
            usage["cache_read_input_tokens"] = r.usage.cache_read_input_tokens
    return _ProviderOutput(text=text, usage=usage, raw=r)


# ── core routing + failover ──────────────────────────────────────────────
def _run_chat(args: ChatArgs) -> ChatResult:
    """Routing + failover, then send this call's runs to ai.runs."""
    try:
        return _run_chat_legs(args)
    finally:
        flush_runs()


def _run_chat_legs(args: ChatArgs) -> ChatResult:
    """Core routing + failover. OCP first when OCP_BASE_URL is set and the route
    has an OCP model, then Anthropic when the route has a paid model and
    ANTHROPIC_API_KEY is set. Models come from ``resolve_route``.
    """
    route = resolve_route(args.task, args.tier, args.model)
    tier = args.tier
    ocp_model = route.get("ocp_model")
    paid_model = route.get("anthropic_model")
    max_tokens = args.max_tokens if args.max_tokens is not None else 8192
    primary = get_provider()
    anthropic_available = anthropic_configured() and bool(paid_model)

    if primary == "ocp" and ocp_model and not _ocp_breaker_open():
        started = _now_ms()
        try:
            out = _call_ocp(args.system, args.messages, ocp_model, max_tokens, args.temperature)
            _note_ocp_result(True)
            ms = int(_now_ms() - started)
            _log_call("ocp", ocp_model, tier, ms, ok=True)
            _enqueue_run(route, "ocp", ocp_model, out.usage, ms, True, False, None)
            return ChatResult(text=out.text, usage=out.usage, raw=out.raw, provider="ocp")
        except Exception as e:  # noqa: BLE001 — routed to failover / re-raised
            _note_ocp_result(False)
            err = _redact_err(e)
            ms = int(_now_ms() - started)
            _log_call("ocp", ocp_model, tier, ms, ok=False, err=err)
            _enqueue_run(route, "ocp", ocp_model, None, ms, False, False, err)
            if not anthropic_available:
                raise

    if not anthropic_available or not paid_model:
        if route.get("budget") == "held":
            raise RuntimeError(f"Daily paid AI cap reached for the BRICK router; {route['task']} has no free leg that answered.")
        raise RuntimeError("No LLM provider configured: set ANTHROPIC_API_KEY or OCP_BASE_URL.")

    fell_over = primary == "ocp" and bool(ocp_model)
    a_started = _now_ms()
    try:
        out = _call_anthropic(args.system, args.messages, paid_model, max_tokens, args.temperature)
        ms = int(_now_ms() - a_started)
        _log_call(
            "anthropic", paid_model, tier, ms, ok=True, failed_over=fell_over,
            cache_write=out.usage.get("cache_creation_input_tokens"),
            cache_read=out.usage.get("cache_read_input_tokens"),
        )
        _enqueue_run(route, "anthropic", paid_model, out.usage, ms, True, fell_over, None)
        return ChatResult(text=out.text, usage=out.usage, raw=out.raw, provider="anthropic")
    except Exception as e:  # noqa: BLE001 — re-raised after logging
        err = _redact_err(e)
        ms = int(_now_ms() - a_started)
        _log_call("anthropic", paid_model, tier, ms, ok=False, failed_over=fell_over, err=err)
        _enqueue_run(route, "anthropic", paid_model, None, ms, False, fell_over, err)
        raise


def chat(args: ChatArgs) -> str:
    """Single round-trip chat. Returns the model's text ("" if none). For
    token counts or the raw provider response, use ``chat_detailed()``.
    """
    return _run_chat(args).text


def chat_detailed(args: ChatArgs) -> ChatResult:
    """Like ``chat()``, but returns the rich ``ChatResult`` — text, usage,
    raw, and the provider that actually answered after failover.
    """
    return _run_chat(args)


# ── retry helpers ────────────────────────────────────────────────────────
LLM_MAX_ATTEMPTS = 3
LLM_BACKOFF_MS = [500, 1500, 4000]

# `ETIMEDOUT` is the connection-timeout code — listed explicitly because the
# literal `TIMEOUT` token does not match it as a substring. `TIMEOUT` still
# covers SDK-specific timeout codes (e.g. `REQUEST_TIMEOUT`).
_TRANSIENT_CODE_RE = ("ETIMEDOUT", "TIMEOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN")


def is_transient_llm_error(e: Any) -> bool:
    """True when an error is worth retrying — 429, any 5xx, or a connection
    error code. Mirrors the TS ``isTransientLLMError``.
    """
    if e is None or not isinstance(e, BaseException):
        return False
    # SDK connection failures and timeouts carry no status or code. Both SDKs
    # name them APIConnectionError / APITimeoutError; match by class name so
    # the SDKs stay lazily imported.
    if any(c.__name__ in ("APIConnectionError", "APITimeoutError") for c in type(e).__mro__):
        return True
    status = getattr(e, "status", None)
    if status is None:
        status = getattr(e, "status_code", None)
    if status == 429:
        return True
    if isinstance(status, int) and 500 <= status < 600:
        return True
    code = getattr(e, "code", None)
    if isinstance(code, str) and code:
        upper = code.upper()
        if any(token in upper for token in _TRANSIENT_CODE_RE):
            return True
    return False


def chat_with_retry(args: ChatArgs) -> str:
    """``chat()`` with transient-error retry. Returns just the text."""
    return chat_detailed_with_retry(args).text


def chat_detailed_with_retry(args: ChatArgs) -> ChatResult:
    """``chat_detailed()`` with up to 3 attempts on transient errors, backing
    off [500, 1500, 4000] ms between attempts.
    """
    last_err: Optional[BaseException] = None
    for attempt in range(LLM_MAX_ATTEMPTS):
        try:
            return _run_chat(args)
        except Exception as e:  # noqa: BLE001 — classified, then retried/raised
            last_err = e
            if not is_transient_llm_error(e) or attempt == LLM_MAX_ATTEMPTS - 1:
                raise
            delay_ms = (
                LLM_BACKOFF_MS[attempt] if attempt < len(LLM_BACKOFF_MS) else 4000
            )
            time.sleep(delay_ms / 1000.0)
    assert last_err is not None  # unreachable — loop always returns or raises
    raise last_err


_T = TypeVar("_T")


class _TimeoutError(RuntimeError):
    """Raised by ``with_timeout`` when the wrapped call exceeds its budget."""


def with_timeout(fn: Callable[[], _T], ms: int, label: str) -> _T:
    """Run ``fn`` with a wall-clock deadline of ``ms`` milliseconds.

    Python port of the TS ``withTimeout``. The TS version races a promise
    against a timer; Python's blocking-by-default model means we run ``fn``
    on a worker thread and abandon it if it overruns. The worker is a daemon
    thread so a stuck call never blocks process exit.
    """
    import threading

    result: Dict[str, Any] = {}

    def _runner() -> None:
        try:
            result["value"] = fn()
        except BaseException as e:  # noqa: BLE001 — surfaced to caller below
            result["error"] = e

    t = threading.Thread(target=_runner, daemon=True)
    t.start()
    t.join(ms / 1000.0)
    if t.is_alive():
        raise _TimeoutError(f"{label} timed out after {ms}ms")
    if "error" in result:
        raise result["error"]
    return result["value"]  # type: ignore[no-any-return]


# ── test seam ────────────────────────────────────────────────────────────
def _reset_breaker() -> None:
    """Reset circuit-breaker state. For tests only — not part of the public
    API and not present in ``llm.ts``.
    """
    global _ocp_failures, _ocp_opened_at
    _ocp_failures = 0
    _ocp_opened_at = 0.0
