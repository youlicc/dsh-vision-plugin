window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-vision-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/paste.ts
		/**
		* Paste-to-path interception, browser half. A capture-phase paste listener
		* runs before the composer's own handler: when the clipboard carries image
		* files and the host verdict says the currently selected model is text-only,
		* the default intake (attachment -> host image admission -> "model does not
		* support images") is suppressed; the bytes go to the plugin's host route
		* (POST /vision-plugin/paste), land as a private temp file, and the returned
		* path is inserted into the composer as plain text. A text-only model then
		* sees exactly what Pi, OpenCode, and Claude Code hand their models: a file
		* path, which is also the describe_image tool's primary trigger.
		* @module @dsh-external/dsh-vision-plugin/client/paste
		*/
		/** Paste temp paths live for a while; only a fresh verdict counts. */
		const VERDICT_MAX_AGE_MS = 6e4;
		/** Extract the image files from a clipboard event, if any. */
		function imageFilesOf(event) {
			const items = event.clipboardData?.items;
			if (items === void 0) return [];
			const files = [];
			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (item === void 0 || item.kind !== "file") continue;
				const file = item.getAsFile();
				if (file !== null && /^image\//.test(file.type)) files.push(file);
			}
			return files;
		}
		/** Insert text into the composer target (or the focused input), firing the input event. */
		function insertText(target, text) {
			const el = target !== null && target.tagName === "TEXTAREA" ? target : target !== null && target.tagName === "INPUT" ? target : document.activeElement;
			if (el === null || el.tagName !== "TEXTAREA" && el.tagName !== "INPUT") return;
			el.focus();
			let inserted = false;
			try {
				inserted = document.execCommand("insertText", false, text);
			} catch {
				inserted = false;
			}
			if (!inserted) {
				const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
				const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
				if (setter === void 0) return;
				setter.call(el, el.value + text);
				el.dispatchEvent(new Event("input", { bubbles: true }));
			}
		}
		/** Upload one image file to the paste endpoint; resolves to its temp path. */
		async function uploadOne(file) {
			const buffer = await file.arrayBuffer();
			const res = await fetch("/vision-plugin/paste", {
				method: "POST",
				body: buffer
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				const error = new Error(body.error ?? `paste upload failed (${res.status})`);
				error.status = res.status;
				throw error;
			}
			return res.json();
		}
		/** The model-selector label the paste verdict resolves against. */
		function currentModelLabel() {
			const buttons = document.querySelectorAll("button[aria-label]");
			for (let i = 0; i < buttons.length; i++) {
				const label = buttons[i]?.getAttribute("aria-label") ?? "";
				if (/select model|current model|选择模型|当前模型/i.test(label)) return label;
			}
			return "";
		}
		/**
		* Install the paste interception. Whether to take a paste over is the HOST's
		* call (GET /vision-plugin/paste with the selector label; the host resolves
		* it against real model metadata). Until a label has a cached `true`, pastes
		* stay native — the safe direction for both a vision model (keeps its
		* thumbnail) and a text-only one (keeps only its old error message, once). A
		* 404 means the route is off, so the client stands down entirely instead of
		* swallowing pastes into a dead endpoint.
		* @returns the disposer removing both capture listeners.
		*/
		function installPasteInterception() {
			let routeAvailable = true;
			const verdicts = /* @__PURE__ */ new Map();
			function refreshVerdict(label) {
				if (!routeAvailable) return;
				const cached = verdicts.get(label);
				if (cached?.pending) return;
				const entry = {
					pending: true,
					takeover: cached?.takeover ?? false,
					at: cached?.at ?? 0
				};
				verdicts.set(label, entry);
				fetch(`/vision-plugin/paste?model=${encodeURIComponent(label)}`).then((res) => {
					if (res.status === 404) {
						routeAvailable = false;
						entry.pending = false;
						return null;
					}
					if (!res.ok) throw new Error(`policy ${res.status}`);
					return res.json();
				}).then((body) => {
					entry.pending = false;
					if (body !== null) {
						entry.takeover = body.takeover === true;
						entry.at = Date.now();
					}
				}).catch(() => {
					entry.pending = false;
				});
			}
			function onFocusIn() {
				refreshVerdict(currentModelLabel());
			}
			function onPaste(event) {
				if (!routeAvailable) return;
				const files = imageFilesOf(event);
				if (files.length === 0) return;
				const label = currentModelLabel();
				const cached = verdicts.get(label);
				refreshVerdict(label);
				if (cached === void 0 || cached.at === 0 || cached.takeover !== true || Date.now() - cached.at > VERDICT_MAX_AGE_MS) return;
				event.preventDefault();
				event.stopImmediatePropagation();
				const target = event.target;
				Promise.all(files.map(uploadOne)).then((results) => {
					const text = results.map((r) => r.path).filter(Boolean).join(" ");
					if (text !== "") insertText(target, `${text} `);
				}).catch((error) => {
					if (error.status === 404) {
						routeAvailable = false;
						verdicts.clear();
					}
					console.error(`[dsh-vision-plugin] paste-to-path failed: ${error.message}`);
				});
			}
			document.addEventListener("focusin", onFocusIn, true);
			document.addEventListener("paste", onPaste, true);
			return () => {
				document.removeEventListener("focusin", onFocusIn, true);
				document.removeEventListener("paste", onPaste, true);
			};
		}
		//#endregion
		//#region src/client/fetch.ts
		/**
		* Small fetch helpers for the vision-model menu endpoints.
		* @module @dsh-external/dsh-vision-plugin/client/fetch
		*/
		/** Fetch JSON from a plugin endpoint, throwing a readable error on failure. */
		async function fetchJson(url, init) {
			const res = await fetch(url, init);
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				const error = new Error(body.error ?? `request failed (${res.status})`);
				error.status = res.status;
				throw error;
			}
			return res.json();
		}
		/** Fetch the offered groups plus the live current selection. */
		function loadVisionGroups() {
			return fetchJson("/vision-plugin/vision-models", { headers: { accept: "application/json" } });
		}
		/** Persist a selection on the host; resolves to the accepted route. */
		function saveVisionRoute(route) {
			return fetchJson("/vision-plugin/vision-model", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(route)
			});
		}
		/** The button copy for one route: the catalog display name when known, else the model id. */
		function routeLabel(groups, current) {
			if (current === null) return "";
			for (const group of groups) {
				if (group.provider !== current.provider) continue;
				for (const model of group.models) if (model.id === current.model) return model.name || current.model;
			}
			return current.model;
		}
		//#endregion
		//#region \0dsh-css:src/client/VisionMenu.module.css.mjs
		const css = ".kKb0aa_root{flex:none;min-width:0;display:inline-flex;position:relative}.kKb0aa_trigger{min-width:0;max-width:220px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:24px;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;display:flex}.kKb0aa_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.kKb0aa_triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.kKb0aa_chevron{color:var(--dsw-alias-label-caption);flex:none}.kKb0aa_panel{z-index:20;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);width:min(280px,100vw - 32px);max-height:min(360px,100vh - 96px);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);border-radius:12px;flex-direction:column;padding:4px;display:flex;position:absolute;bottom:calc(100% + 8px);right:0;overflow:hidden}.kKb0aa_list{min-height:0;overflow-y:auto}.kKb0aa_groupTitle{z-index:1;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-tertiary);padding:5px 8px 3px;font-size:12px;font-weight:500;line-height:18px;position:sticky;top:0}.kKb0aa_option{width:100%;min-height:38px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:none;border-radius:10px;outline:none;align-items:center;gap:8px;padding:6px 8px;display:flex}.kKb0aa_option:hover:not(:disabled),.kKb0aa_option:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}.kKb0aa_selected,.kKb0aa_selected:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-accent);box-shadow:inset 0 0 0 1px var(--dsw-static-neutral-bluish-400)}.kKb0aa_optionName{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;font-size:14px;font-weight:500;line-height:20px;overflow:hidden}.kKb0aa_check{color:var(--dsw-alias-label-primary);flex:0 0 18px;place-items:center;display:grid}.kKb0aa_status{color:var(--dsw-alias-label-tertiary);padding:10px;font-size:13px;line-height:20px}.kKb0aa_error{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-radius:8px;margin-bottom:4px;padding:7px 8px;font-size:12px;line-height:18px}";
		const tagId = "@dsh-external/dsh-vision-plugin/VisionMenu.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-external/dsh-vision-plugin";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var VisionMenu_module_css_default = {
			"check": "kKb0aa_check",
			"chevron": "kKb0aa_chevron",
			"error": "kKb0aa_error",
			"groupTitle": "kKb0aa_groupTitle",
			"list": "kKb0aa_list",
			"option": "kKb0aa_option",
			"optionName": "kKb0aa_optionName",
			"panel": "kKb0aa_panel",
			"root": "kKb0aa_root",
			"selected": "kKb0aa_selected",
			"status": "kKb0aa_status",
			"trigger": "kKb0aa_trigger",
			"triggerLabel": "kKb0aa_triggerLabel"
		};
		//#endregion
		//#region src/client/VisionModelMenu.tsx
		/**
		* The composer vision-model menu. Registered into `conversation.input.right`
		* (right end of the tool row, before the send button) by the client plugin
		* body. The dropdown lists the offered free vision models grouped by
		* provider (GET /vision-plugin/vision-models); clicking a row POSTs
		* /vision-plugin/vision-model and re-reads the selection. Hidden entirely
		* when no configured provider offers a free vision model.
		* @module @dsh-external/dsh-vision-plugin/client/VisionModelMenu
		*/
		/**
		* One composer-instance menu: mounts with the seat, so each session's
		* composer owns a copy; the selection itself lives on the HOST (shared
		* across sessions), so every instance converges on the same POST result.
		*/
		function VisionModelMenu() {
			const [snap, setSnap] = (0, react.useState)({
				open: false,
				loading: true,
				error: "",
				groups: [],
				current: null
			});
			const rootRef = (0, react.useRef)(null);
			const load = (0, react.useCallback)(() => {
				loadVisionGroups().then((body) => {
					setSnap((prev) => ({
						...prev,
						loading: false,
						error: "",
						groups: body.groups,
						current: body.current
					}));
				}).catch((error) => {
					setSnap((prev) => ({
						...prev,
						loading: false,
						error: error.message
					}));
				});
			}, []);
			(0, react.useEffect)(() => {
				load();
			}, [load]);
			(0, react.useEffect)(() => {
				if (snap.open) load();
			}, [snap.open, load]);
			(0, react.useEffect)(() => {
				if (!snap.open) return;
				const closeOutside = (event) => {
					if (!rootRef.current?.contains(event.target)) setSnap((prev) => ({
						...prev,
						open: false
					}));
				};
				const closeOnEscape = (event) => {
					if (event.key === "Escape") setSnap((prev) => ({
						...prev,
						open: false
					}));
				};
				document.addEventListener("mousedown", closeOutside);
				document.addEventListener("keydown", closeOnEscape);
				return () => {
					document.removeEventListener("mousedown", closeOutside);
					document.removeEventListener("keydown", closeOnEscape);
				};
			}, [snap.open]);
			const choose = (provider, model) => {
				saveVisionRoute({
					provider,
					model
				}).then((route) => {
					setSnap((prev) => ({
						...prev,
						open: false,
						error: "",
						current: route
					}));
				}).catch((error) => {
					setSnap((prev) => ({
						...prev,
						error: error.message
					}));
				});
			};
			if (!snap.loading && snap.groups.length === 0) return null;
			const label = routeLabel(snap.groups, snap.current);
			const triggerText = snap.current !== null ? `视觉：${label}` : "视觉：选择";
			const triggerAria = snap.current !== null ? `视觉模型：${label}` : "选择视觉模型";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				className: VisionMenu_module_css_default.root,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: VisionMenu_module_css_default.trigger,
					"aria-label": triggerAria,
					"aria-haspopup": "menu",
					"aria-expanded": snap.open,
					title: triggerText,
					onClick: () => setSnap((prev) => ({
						...prev,
						open: !prev.open
					})),
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: VisionMenu_module_css_default.triggerLabel,
						children: triggerText
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: VisionMenu_module_css_default.chevron,
						"aria-hidden": true,
						children: "▾"
					})]
				}), snap.open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					role: "menu",
					"aria-label": "视觉模型",
					className: VisionMenu_module_css_default.panel,
					children: [snap.error !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: VisionMenu_module_css_default.error,
						children: snap.error
					}), snap.loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: VisionMenu_module_css_default.status,
						children: "加载中…"
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: VisionMenu_module_css_default.list,
						children: snap.groups.map((group) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: VisionMenu_module_css_default.groupTitle,
							children: group.displayName
						}), group.models.map((model) => {
							const selected = snap.current !== null && snap.current.provider === group.provider && snap.current.model === model.id;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								role: "menuitemradio",
								"aria-checked": selected,
								className: selected ? `${VisionMenu_module_css_default.option} ${VisionMenu_module_css_default.selected}` : VisionMenu_module_css_default.option,
								title: model.name || model.id,
								onClick: () => choose(group.provider, model.id),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: VisionMenu_module_css_default.optionName,
									children: model.name || model.id
								}), selected && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: VisionMenu_module_css_default.check,
									"aria-hidden": true,
									children: "✓"
								})]
							}, model.id);
						})] }, group.provider))
					})]
				})]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** Required services: the slot registry owning the composer input seats. */
		const inject = ["slots"];
		/**
		* Client plugin body: register the menu into `conversation.input.right` once
		* the composer declares it (re-registering if that declaration reloads), and
		* install the paste interception. Both contributions are fiber-owned effects
		* — cordis collects them and disposes on unload.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "vision-model-menu",
				order: 10
			}, VisionModelMenu));
			ctx.effect(() => installPasteInterception(), "dsh-vision-plugin: paste-to-path");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map