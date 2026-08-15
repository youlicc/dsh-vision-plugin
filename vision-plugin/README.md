# @dsh-external/dsh-vision-plugin

Vision bridge for text-only routes: pasted images become temp-file paths (paste-to-path), the `describe_image` tool reads them through a configurable vision provider, returning the description as text, and the composer shows a vision-model menu that picks the free vision model used for recognition.

## What it does

- **Vision-model menu (composer)**: a `视觉：<模型>` button in the composer tool row (the `conversation.input.right` seat, right before the send button) opens a provider-grouped dropdown of the **free** vision models offered by the currently configured providers. The free list is the plugin-maintained `FREE_VISION_MODELS` catalog (never scanned from model metadata): OpenRouter's four `:free` models and OpenCode's `mimo-v2.5-free`. The default selection is the first offered model in catalog order; clicking a model switches the vision route for the next recognition. No configured provider offering a free model → the button is hidden entirely.
- **Paste-to-path intake**: the browser half (`lib/client.js`) intercepts image pastes on a capture-phase listener. When the host verdict says the selected model is text-only, the paste is taken over: the bytes upload to `POST /vision-plugin/paste`, land as a private (0600) temp file in a fresh unpredictable temp dir, and the returned path is inserted into the composer as plain text. A text-only model never trips image admission; a vision model keeps its native thumbnail paste (the verdict resolves the selector label against real model metadata, `GET /vision-plugin/paste?model=<label>`).
- **`describe_image` tool**: reads a local PNG/JPEG/WebP/GIF file (workspace or pasted temp path) with node's own fs, durably commits it through the attachment service, describes it through the vision model chain, and returns the description as text. The image never enters the routed model's request as an image block.
- **`describe_attachment` tool**: re-reads a durable image by its attachment id (`sha256:…`) straight from the content-addressed attachment store (`$DSH_HOME/attachments/v1/objects/…`), recovers the media type from the bytes, and describes it through the same chain. This is the channel a wrapped-`(vision)` model uses to inspect the original pixels when the auto-description needs verification — the rewrite text carries the attachment id and points the model here instead of searching local files.

## Config

Plugin entry `config` (cordis.yml / settings), all optional:

| Field | Default | Meaning |
|---|---|---|
| `provider` | absent | Vision provider route. Absent (with `models` absent) → the composer menu selection decides; present → explicit configuration wins. |
| `models` | absent | Ordered fallback chain; first non-empty success wins. Absent (with `provider` absent) → menu selection plus the same provider's remaining free models as fallback. |
| `systemPrompt` | Chinese describe prompt | System prompt for the vision call. |
| `visionMenu` | `true` | Composer vision-model menu on/off. Off → recognition falls back to the explicit config only. |
| `pasteToPath` | `true` | Browser paste interception on/off. |
| `pasteMaxBytes` | 20 MiB | Upload cap for the paste endpoint. |
| `pasteRetentionMs` | 24h | Paste temp dirs older than this are swept. |
| `maxOutputTokens` | 2048 | Output cap per vision call. |
| `timeoutMs` | 60000 | Per-model call timeout. |
| `maxInputBytes` | 0 (attachment limit) | Byte cap for one described image. |

## Behavior notes

- Route resolution order: explicit `provider`/`models` config first, then the composer menu selection (with same-provider free-model fallback), then a clear error telling you to configure a provider or pick a free model in the menu.
- The menu lists only **configured providers** (routes registered in the llm topology) and only **free** models from the plugin's own catalog; a provider whose catalog lacks any free vision model is skipped.
- Provider/model are plain configuration: switching to SiliconFlow, Anthropic, or a local Ollama route is a config change, never a code change. The only constraint is that the vision route lives on the pi-ai adapter family (the DeepSeek official adapter is text-only).
- Recognition is deduplicated in-flight per image bytes; identical concurrent calls share one vision request.
- **Multi-image messages recognize in parallel**: a wrapped-`(vision)` turn with N images fires the N recognition calls concurrently, so the pre-token stall scales with one recognition (free models queue 30-80s), not N. A single failed recognition degrades to an inline placeholder instead of failing the request.
- The paste route and the vision-model menu mount only when a web server is present (`ctx.inject(['webServer'])`): headless deployments stay a tool-only bridge.
- No dsh source changes are required: the plugin consumes only public services (`ctx.llm`, `ctx.attachments`, `ctx.tools`, `ctx.webServer`, `ctx.slots`).

## Paste temp files: lifecycle and selection

- Pasted images land in a private (0600) dir `dsh-vision-paste-<random>/paste-<epoch-ms>.<ext>` under the OS temp dir; the path text in the composer is the only reference the model needs.
- These dirs are **one-shot inputs**: `cleanupStalePasteDirs` sweeps any `dsh-vision-paste-*` dir whose newest file is older than `pasteRetentionMs` (default 24h), run at mount and after every accepted paste. Stale images never accumulate in TEMP, so an agent searching for "the current paste" cannot mistake an old one for a fresh paste.
- Selection principle when a model needs to re-read the image behind a wrapped-`(vision)` message (no path in the log): prefer the **newest** `dsh-vision-paste-*` dir; the most accurate choice is the dir whose creation time is **closest to the message's timestamp** — pastes map one-to-one to messages, so time alignment excludes older residue.

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

### Development-time dependency on the harness checkout

The dsh packages this plugin consumes (`@deepseek-ai/dsh-llm`, `dsh-tools`, `dsh-attachment`, …) are **private and not installable from npm**. At **development time** (type checking, tests, builds) the toolchain therefore resolves them from a **local harness checkout that must sit at `../deepseek-harness` relative to this repo** (a sibling directory). This is a compile-time-only constraint:

- `tsconfig.json` extends `../deepseek-harness/tsconfig.base.client.json` and pulls its `paths` from `./harness.paths.json`, which points every `@deepseek-ai/*` import at the sibling checkout's source or built `lib/types` declarations.
- `vitest.config.ts` and `tsdown.config.ts` resolve the harness via the same `../deepseek-harness` relative path.

**Runtime loading does NOT depend on this layout.** When dsh installs the plugin (into `$DSH_HOME/profiles/<name>/node_modules/`), the `@deepseek-ai/*` imports inside the built `lib/` resolve from dsh's own installation — the plugin ships no dsh dependencies (peerDependencies only) and runs anywhere dsh runs. The harness sibling requirement applies only to developing this repo.

### Commands

```sh
# Tests resolve the harness source tree via tsconfig paths (see vitest.config.ts)
vitest run
# Type check: one tsconfig.json covers both the host program (src/) and the
# browser half (src/client) — the editor discovers only tsconfig.json, so the
# merged project is what VSCode's TS server resolves against.
tsc --noEmit
# Dual-face build: lib/index.js (host) + lib/client.js (browser lazy-CJS bundle)
tsdown
```

The package's single tsconfig extends `deepseek-harness/tsconfig.base.client.json` (JSX + DOM lib) with node types restored for the host half; runtime/test resolution points vendored framework packages and react at the harness install (Vite alias) and dsh packages at their built `lib/types` declarations (`harness.paths.json`). Building requires the harness `node_modules` for the toolchain. The browser half is TypeScript + React under `src/client/`, compiled by the shared `clientBundle` preset from the harness (`lib/client.js`), with CSS Modules injected as `<style data-plugin>` tags at materialization.

## Known Limitations and Deferred Work

- **Menu selection is not persisted** — a page reload returns to the default (first offered free model); remembering the last pick is deferred.
- **Paid vision models are not in the menu** — the menu lists only the plugin's free catalog; paid models remain a configuration choice.
- **Pasted images render as path text, not thumbnails** — the paste-to-path tradeoff (same as the community `modlens` plugin); a client renderer that turns the temp path into a thumbnail is deferred.
- **Free vision models are rate-limited** — OpenRouter `:free` models run about 20 requests/minute and can be retired upstream; the fallback chain and configurable model list absorb that.
- **Recognition memory is not persisted** — identical bytes are deduplicated only in-flight; a description cache keyed by content hash is deferred.
- **`describe_image` reads with node's own fs** — it can read any path the host process can (the paste temp files live outside the workspace); sandbox-aware reading via `ctx.fs` is deferred.
- **Pixel-level tools (crop/OCR/grounding) are not included** — the community `dsh-vision-router` package shows that direction; see the project README comparison.
