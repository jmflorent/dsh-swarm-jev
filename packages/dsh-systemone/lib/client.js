window.__ModuleLoader__.load({
	id: "@local/systemone",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/** Locale namespace for this settings page. */
		const NS = "settings.systemone";
		/** Host plugin entry id (the profile row) whose volatile fields this page edits. */
		const ENTRY_ID = "systemone";
		/** Credential reference used when the config does not name one. */
		const DEFAULT_API_KEY_REF = "SYSTEMONE_API_KEY";
		/** Section placement in the Settings navigation. */
		const SECTION_ORDER = 40;
		const MODES = ["off", "shadow", "enforce", "swarm"];

		const en = {
			nav: "Decision model",
			title: "Decision model",
			description:
				"Endpoint and credentials for the self-hosted System One / Mammoth decision model. " +
				"The same host is used by systemone_ask, swarm_assign, and the tool-decision layer. " +
				"Changes take effect at the next decision; no restart is needed.",
			endpoint: "Endpoint URL",
			endpointHint: "Full URL that receives decision POST requests, for example http://127.0.0.1:8008/v1/systemone.",
			model: "Model id",
			modelHint: "Sent as the request model. The service decides which model ids and aliases it accepts.",
			timeout: "Timeout (ms)",
			timeoutHint: "Per-call deadline for a single decision request.",
			mode: "Decision layer mode",
			modeHint:
				"off: inactive · shadow: record decisions only · enforce: narrow every tool call · swarm: enforce only inside a swarm-mode session.",
			modeOff: "Off",
			modeShadow: "Shadow (record only)",
			modeEnforce: "Enforce",
			modeSwarm: "Swarm sessions only",
			apiKey: "API key",
			apiKeyHint:
				"Stored by the DSH credential service, never in the settings file. Leave blank to keep the current key.",
			apiKeySet: "A key is configured.",
			apiKeyUnset: "No key is configured; requests carry no Authorization header.",
			clearKey: "Clear key",
			credentialRef: "Credential reference",
			saving: "Saving…",
			save: "Save",
			saved: "Saved. The next decision uses the new values.",
			invalidEndpoint: "Enter a full http(s) URL.",
			invalidModel: "Enter a model id.",
			invalidTimeout: "Enter a whole number of milliseconds (at least 500).",
			loadFailed: "The Host does not expose settings for this plugin.",
			notWritable: "This deployment's settings are read-only.",
			conflict: "The settings changed elsewhere. The latest values were reloaded; review them and save again.",
			writeFailed: "The settings could not be saved.",
			credentialWriteFailed: "The settings were saved, but the API key could not be written.",
			credentialCleared: "The stored key was cleared.",
			credentialClearFailed: "The key could not be cleared.",
			loading: "Loading…",
		};

		const zh = {
			nav: "决策模型",
			title: "决策模型",
			description:
				"自托管 System One / Mammoth 决策模型的地址与凭据。systemone_ask、swarm_assign " +
				"和工具决策层共用同一个服务端。修改在下次决策时生效，无需重启。",
			endpoint: "服务地址",
			endpointHint: "接收决策 POST 请求的完整 URL，例如 http://127.0.0.1:8008/v1/systemone。",
			model: "模型 ID",
			modelHint: "作为请求的 model 发送；可用的模型 ID 与别名由服务端决定。",
			timeout: "超时（毫秒）",
			timeoutHint: "单次决策请求的调用时限。",
			mode: "决策层模式",
			modeHint:
				"off：关闭 · shadow：只记录决策 · enforce：约束每次工具调用 · swarm：仅在 swarm 模式会话内生效。",
			modeOff: "关闭",
			modeShadow: "影子（仅记录）",
			modeEnforce: "强制",
			modeSwarm: "仅 swarm 会话",
			apiKey: "API 密钥",
			apiKeyHint: "由 DSH 凭据服务保存，不写入设置文件。留空表示保留现有密钥。",
			apiKeySet: "已配置密钥。",
			apiKeyUnset: "未配置密钥；请求不带 Authorization 头。",
			clearKey: "清除密钥",
			credentialRef: "凭据引用",
			saving: "保存中…",
			save: "保存",
			saved: "已保存，下次决策使用新值。",
			invalidEndpoint: "请输入完整的 http(s) URL。",
			invalidModel: "请输入模型 ID。",
			invalidTimeout: "请输入不小于 500 的整数毫秒值。",
			loadFailed: "Host 未提供该插件的设置。",
			notWritable: "此部署的设置为只读。",
			conflict: "设置已在别处修改，已重新载入最新值，请检查后再次保存。",
			writeFailed: "设置保存失败。",
			credentialWriteFailed: "设置已保存，但 API 密钥写入失败。",
			credentialCleared: "已清除保存的密钥。",
			credentialClearFailed: "无法清除密钥。",
			loading: "加载中…",
		};

		const styles = {
			root: {
				display: "flex",
				flexDirection: "column",
				gap: "18px",
				maxWidth: "720px",
				padding: "8px 4px 16px",
				fontSize: "13px",
				lineHeight: 1.5,
			},
			title: { margin: 0, fontSize: "16px", fontWeight: 600 },
			description: { margin: 0, opacity: 0.72, fontSize: "13px" },
			field: { display: "flex", flexDirection: "column", gap: "6px" },
			label: { fontWeight: 500 },
			hint: { fontSize: "12px", opacity: 0.62 },
			input: {
				font: "inherit",
				padding: "8px 10px",
				borderRadius: "8px",
				border: "1px solid rgba(127,127,127,0.38)",
				background: "transparent",
				color: "inherit",
				width: "100%",
				boxSizing: "border-box",
			},
			row: { display: "flex", gap: "12px", alignItems: "flex-end" },
			rowField: { display: "flex", flexDirection: "column", gap: "6px", flex: "1 1 0" },
			actions: { display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" },
			primary: {
				padding: "8px 16px",
				borderRadius: "8px",
				border: "none",
				background: "#2f6fed",
				color: "#fff",
				fontWeight: 600,
				cursor: "pointer",
			},
			secondary: {
				padding: "8px 14px",
				borderRadius: "8px",
				border: "1px solid rgba(127,127,127,0.38)",
				background: "transparent",
				color: "inherit",
				cursor: "pointer",
			},
			disabled: { opacity: 0.55, cursor: "default" },
			ok: { color: "#1a7f37", fontSize: "12px" },
			error: { color: "#b3261e", fontSize: "12px" },
			status: { fontSize: "12px", opacity: 0.7 },
			code: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" },
		};

		const isHttpUrl = (value) => /^https?:\/\/\S+$/i.test(value.trim());

		const numberOf = (value) => (typeof value === "number" ? value : Number(value));

		function DecisionModelSection(props) {
			const { ctx, t } = props;
			const form = ctx.configForms.get(ENTRY_ID);
			const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot());
			const [draft, setDraft] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [message, setMessage] = React.useState(undefined);
			const [credential, setCredential] = React.useState({ configured: false, writable: true });

			React.useEffect(() => form.subscribe(() => setSnapshot(form.getSnapshot())), [form]);

			const value = snapshot.value !== undefined && snapshot.value !== null ? snapshot.value : {};
			const ref =
				typeof value.apiKeyRef === "string" && value.apiKeyRef.trim() !== ""
					? value.apiKeyRef.trim()
					: DEFAULT_API_KEY_REF;

			const draftOf = (source) => ({
				endpoint: typeof source.endpoint === "string" ? source.endpoint : "",
				model: typeof source.model === "string" ? source.model : "",
				timeoutMs: typeof source.timeoutMs === "number" ? String(source.timeoutMs) : String(source.timeoutMs ?? ""),
				mode: typeof source.mode === "string" ? source.mode : "shadow",
				apiKey: "",
			});

			React.useEffect(() => {
				if (snapshot.status !== "ready") return;
				// Populate once, and again after a save clears the draft; a draft the
				// user is editing is never overwritten by a background publication.
				setDraft((current) => (current !== null ? current : draftOf(value)));
			}, [snapshot.status, snapshot.revision]);

			const readCredential = React.useCallback(async () => {
				try {
					const response = await ctx.remote.credentials.describe([ref]);
					if (response === undefined || !response.ok) return;
					const view = response.value !== undefined && response.value !== null ? response.value[ref] : undefined;
					setCredential({
						configured: view?.configured === true,
						writable: view?.writable !== false,
					});
				} catch {
					/* A deployment without a credential provider keeps the default banner. */
				}
			}, [ctx, ref]);

			React.useEffect(() => {
				readCredential();
			}, [readCredential]);

			const writable = snapshot.writable === true;
			const loading = snapshot.status === "loading";
			const unavailable = snapshot.status === "unavailable";

			const update = (key) => (event) => {
				const next = event.target.value;
				setDraft((current) => (current === null ? current : { ...current, [key]: next }));
				setMessage(undefined);
			};

			const validate = () => {
				if (!isHttpUrl(draft.endpoint)) return t("invalidEndpoint");
				if (draft.model.trim() === "") return t("invalidModel");
				const timeout = numberOf(draft.timeoutMs);
				if (!Number.isInteger(timeout) || timeout < 500) return t("invalidTimeout");
				if (!MODES.includes(draft.mode)) return t("invalidTimeout");
				return undefined;
			};

			const save = async () => {
				if (draft === null || busy || !writable) return;
				const invalid = validate();
				if (invalid !== undefined) {
					setMessage({ kind: "error", text: invalid });
					return;
				}
				setBusy(true);
				setMessage(undefined);
				try {
					const ops = [];
					if (draft.endpoint.trim() !== (typeof value.endpoint === "string" ? value.endpoint : "")) {
						ops.push({ op: "set", path: ["endpoint"], value: draft.endpoint.trim() });
					}
					if (draft.model.trim() !== (typeof value.model === "string" ? value.model : "")) {
						ops.push({ op: "set", path: ["model"], value: draft.model.trim() });
					}
					if (numberOf(draft.timeoutMs) !== numberOf(value.timeoutMs)) {
						ops.push({ op: "set", path: ["timeoutMs"], value: numberOf(draft.timeoutMs) });
					}
					if (draft.mode !== value.mode) {
						ops.push({ op: "set", path: ["mode"], value: draft.mode });
					}
					if (ops.length > 0) {
						const accepted = await form.mutate(ops);
						if (!accepted) {
							setMessage({ kind: "error", text: t("conflict") });
							setDraft(null);
							return;
						}
					}
					if (draft.apiKey !== "") {
						const written = await ctx.remote.credentials.set(ref, draft.apiKey);
						if (written === undefined || !written.ok) {
							setMessage({ kind: "error", text: t("credentialWriteFailed") });
							return;
						}
						await readCredential();
					}
					const fresh = form.getSnapshot();
					setDraft(fresh.status === "ready" ? draftOf(fresh.value) : null);
					setMessage({ kind: "ok", text: t("saved") });
				} catch {
					setMessage({ kind: "error", text: t("writeFailed") });
				} finally {
					setBusy(false);
				}
			};

			const clearKey = async () => {
				if (busy || !writable) return;
				setBusy(true);
				setMessage(undefined);
				try {
					const cleared = await ctx.remote.credentials.unset(ref);
					if (cleared === undefined || !cleared.ok) {
						setMessage({ kind: "error", text: t("credentialClearFailed") });
						return;
					}
					await readCredential();
					setMessage({ kind: "ok", text: t("credentialCleared") });
				} catch {
					setMessage({ kind: "error", text: t("credentialClearFailed") });
				} finally {
					setBusy(false);
				}
			};

			const inputProps = (key, type) => ({
				type: type !== undefined ? type : "text",
				value: draft !== null ? draft[key] : "",
				onChange: update(key),
				onBlur: () => setMessage(undefined),
				style: styles.input,
				spellCheck: false,
				autoComplete: "off",
				disabled: busy || !writable,
			});

			const field = (label, control, hint) =>
				h(
					"label",
					{ style: styles.field },
					h("span", { style: styles.label }, label),
					control,
					hint !== undefined ? h("span", { style: styles.hint }, hint) : null,
				);

			if (loading) return h("div", { style: styles.root }, h("p", { style: styles.status }, t("loading")));
			if (unavailable) return h("div", { style: styles.root }, h("p", { style: styles.error }, t("loadFailed")));
			if (draft === null) return h("div", { style: styles.root }, h("p", { style: styles.status }, t("loading")));

			return h(
				"div",
				{ style: styles.root },
				h("h2", { style: styles.title }, t("title")),
				h("p", { style: styles.description }, t("description")),
				field(t("endpoint"), h("input", { ...inputProps("endpoint", "url"), placeholder: "http://127.0.0.1:8008/v1/systemone" }), t("endpointHint")),
				field(t("model"), h("input", { ...inputProps("model"), placeholder: "decision-model" }), t("modelHint")),
				h(
					"div",
					{ style: styles.row },
					h(
						"label",
						{ style: styles.rowField },
						h("span", { style: styles.label }, t("timeout")),
						h("input", { ...inputProps("timeoutMs", "number"), min: 500, step: 100 }),
					),
					h(
						"label",
						{ style: styles.rowField },
						h("span", { style: styles.label }, t("mode")),
						h(
							"select",
							{
								value: draft.mode,
								onChange: update("mode"),
								style: styles.input,
								disabled: busy || !writable,
							},
							MODES.map((mode) =>
								h(
									"option",
									{ key: mode, value: mode },
									t(mode === "off" ? "modeOff" : mode === "shadow" ? "modeShadow" : mode === "enforce" ? "modeEnforce" : "modeSwarm"),
								),
							),
						),
					),
				),
				h("p", { style: styles.hint }, t("modeHint")),
				field(
					t("apiKey"),
					h("input", { ...inputProps("apiKey", "password"), placeholder: credential.configured ? "••••••••" : "" }),
					t("apiKeyHint"),
				),
				h(
					"div",
					{ style: styles.status },
					credential.configured ? t("apiKeySet") : t("apiKeyUnset"),
					" · ",
					t("credentialRef"),
					": ",
					h("span", { style: styles.code }, ref),
				),
				h(
					"div",
					{ style: styles.actions },
					h(
						"button",
						{
							type: "button",
							onClick: save,
							style: { ...styles.primary, ...(busy || !writable ? styles.disabled : {}) },
							disabled: busy || !writable,
						},
						busy ? t("saving") : t("save"),
					),
					credential.configured
						? h(
								"button",
								{
									type: "button",
									onClick: clearKey,
									style: { ...styles.secondary, ...(busy || !writable || !credential.writable ? styles.disabled : {}) },
									disabled: busy || !writable || !credential.writable,
								},
								t("clearKey"),
							)
						: null,
					!writable ? h("span", { style: styles.hint }, t("notWritable")) : null,
				),
				message !== undefined
					? h("p", { style: message.kind === "ok" ? styles.ok : styles.error }, message.text)
					: null,
			);
		}

		/** Services this browser plugin needs at apply time. */
		const inject = ["slots", "locale", "remote", "remote.credentials", "configForms"];

		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { en, zh }), "systemone-settings: dictionaries");
			ctx.effect(
				() =>
					ctx.configForms.whileServed([ENTRY_ID], () =>
						ctx.slots.inject("settings.section", () =>
							ctx.slots.register(
								{
									name: "settings.section",
									id: ENTRY_ID,
									order: SECTION_ORDER,
									label: () => t("nav"),
									locale: NS,
									inject: () => ({ ctx, t }),
								},
								DecisionModelSection,
							),
						),
					),
				"systemone-settings: settings section",
			);
		}

		exports.inject = inject;
		exports.apply = apply;
		exports.NS = NS;
		exports.ENTRY_ID = ENTRY_ID;
		return module.exports;
	},
});
