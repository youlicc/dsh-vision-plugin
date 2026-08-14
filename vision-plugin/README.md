# @dsh-external/dsh-vision-plugin

Vision bridge for text-only routes: pasted images become temp-file paths (paste-to-path), and the `describe_image` tool reads them through a configurable vision provider, returning the description as text.

## What it does

- **Paste-to-path intake**: the browser half (`client.js`) intercepts image pastes on a capture-phase listener. When the host verdict says the selected model is text-only, the paste is taken over: the bytes upload to `POST /vision-plugin/paste`, land as a private (0600) temp file in a fresh unpredictable temp dir, and the returned path is inserted into the composer as plain text. A text-only model never trips image admission; a vision model keeps its native thumbnail paste (the verdict resolves the selector label against real model metadata, `GET /vision-plugin/paste?model=<label>`).
- **`describe_image` tool**: reads a local PNG/JPEG/WebP/GIF file (workspace or pasted temp path) with node's own fs, durably commits it through the attachment service, describes it through the vision model chain, and returns the description as text. The image never enters the routed model's request as an image block.

## Config

Plugin entry `config` (cordis.yml / settings), all optional:

| Field | Default | Meaning |
|---|---|---|
| `provider` | `openrouter` | Vision provider route (any registered llm route). |
| `models` | four OpenRouter free vision models | Ordered fallback chain; first non-empty success wins. |
| `systemPrompt` | Chinese describe prompt | System prompt for the vision call. |
| `pasteToPath` | `true` | Browser paste interception on/off. |
| `pasteMaxBytes` | 20 MiB | Upload cap for the paste endpoint. |
| `maxOutputTokens` | 2048 | Output cap per vision call. |
| `timeoutMs` | 60000 | Per-model call timeout. |
| `maxInputBytes` | 0 (attachment limit) | Byte cap for one described image. |

## Behavior notes

- Provider/model are plain configuration: switching to SiliconFlow, Anthropic, or a local Ollama route is a config change, never a code change. The only constraint is that the vision route lives on the pi-ai adapter family (the DeepSeek official adapter is text-only).
- Recognition is deduplicated in-flight per image bytes; identical concurrent calls share one vision request.
- The paste route mounts only when a web server is present (`ctx.inject(['webServer'])`): headless deployments stay a tool-only bridge.
- No dsh source changes are required: the plugin consumes only public services (`ctx.llm`, `ctx.attachments`, `ctx.tools`, `ctx.webServer`).

## Model Experience

### Provider request through the vision bridge

#### What the model sees

The vision model receives the configured Chinese system prompt, the caller's question, and the image as one user message. The main (text-only) session sees only the temp-file path text and, once the tool runs, the description envelope.

#### Token effect

The main session's requests carry the description text only; the image never reaches the text route. Each recognition call consumes tokens on the vision provider route; repeated calls for identical bytes are deduplicated in-flight.

#### KV Cache effect

Vision calls are independent one-shot requests; no provider-side replay state is shared with the main session. Changing the configured vision provider or model chain takes effect on the next recognition without invalidating main-session cache prefixes (the main route is untouched).

### Provider response

#### What the model sees

Vision text is surfaced to the main agent as the `describe_image` tool result; the main model reasons over the description.

#### Token effect

Description text enters the main session log once as a tool result and is replayed with it.

#### KV Cache effect

A landed description appends to the session log, so later main-route requests include it in the durable prefix.

## Development

```sh
# Tests resolve the harness source tree via tsconfig paths (see vitest.config.ts)
vitest run
tsc --noEmit
```

The package's tsconfig extends `deepseek-harness/tsconfig.base.json`; runtime/test resolution points vendor packages at their `src` (Vite alias) and dsh packages at their `src` (tsconfig paths). Building requires the harness `node_modules` (a junction on Windows) for the toolchain. The browser half is a hand-written lazy-CJS bundle (`client.js`, zero imports) — no build step.

## Known Limitations and Deferred Work

- **Pasted images render as path text, not thumbnails** — the paste-to-path tradeoff (same as the community `modlens` plugin); a client renderer that turns the temp path into a thumbnail is deferred.
- **Free vision models are rate-limited** — OpenRouter `:free` models run about 20 requests/minute and can be retired upstream; the fallback chain and configurable model list absorb that.
- **Recognition memory is not persisted** — identical bytes are deduplicated only in-flight; a description cache keyed by content hash is deferred.
- **`describe_image` reads with node's own fs** — it can read any path the host process can (the paste temp files live outside the workspace); sandbox-aware reading via `ctx.fs` is deferred.
- **Pixel-level tools (crop/OCR/grounding) are not included** — the community `dsh-vision-router` package shows that direction; see the project README comparison.
