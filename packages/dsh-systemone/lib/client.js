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

		/** Right-sidebar page type for the live swarm panel. */
		const SWARM_KIND = "systemone-swarm";
		const SWARM_TAB_ID = "@local/systemone/swarm-panel";
		/** Same-origin JSON snapshot published by the host half of this plugin. */
		const SWARM_PANEL_PATH = "systemone/panel.json";
		const SWARM_POLL_MS = 3000;

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
			panelTitle: "Swarm",
			panelGuideTitle: "Swarm",
			panelGuideDescription: "Live swarm state: sessions in swarm mode, personas, assignments, and recent decisions.",
			panelRefresh: "Refresh now",
			panelCollapse: "Collapse panel",
			panelActive: "ACTIVE",
			panelIdle: "IDLE",
			panelSessions: "Swarm sessions",
			panelPersonas: "Personas",
			panelOperations: "Recent operations",
			panelCounters: "Counters",
			panelNoSwarm: "No session is in swarm mode.",
			panelNoSwarmHint: "Run swarm_enter in a session to start the swarm.",
			panelNoOps: "No decisions recorded yet.",
			panelThisSession: "this session",
			panelSession: "session",
			panelConnecting: "Connecting to the swarm control plane…",
			panelUnavailable: "The swarm panel endpoint is unavailable.",
			panelUpdated: "updated",
			panelMode: "mode",
			panelEndpoint: "endpoint",
			panelModel: "model",
			panelObjectives: "Objectives",
			panelNoObjectives: "No objectives tracked.",
			panelObjRunning: "engine running",
			panelObjPaused: "engine paused",
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
			panelTitle: "Swarm",
			panelGuideTitle: "Swarm 面板",
			panelGuideDescription: "实时 swarm 状态：处于 swarm 模式的会话、角色、分配以及最近决策。",
			panelRefresh: "立即刷新",
			panelCollapse: "收起面板",
			panelActive: "运行中",
			panelIdle: "空闲",
			panelSessions: "Swarm 会话",
			panelPersonas: "角色",
			panelOperations: "最近操作",
			panelCounters: "计数器",
			panelNoSwarm: "当前没有会话处于 swarm 模式。",
			panelNoSwarmHint: "在某个会话中运行 swarm_enter 即可启动 swarm。",
			panelNoOps: "还没有记录决策。",
			panelThisSession: "当前会话",
			panelSession: "会话",
			panelConnecting: "正在连接 swarm 控制面…",
			panelUnavailable: "无法访问 swarm 面板接口。",
			panelUpdated: "更新于",
			panelMode: "模式",
			panelEndpoint: "地址",
			panelModel: "模型",
			panelObjectives: "目标",
			panelNoObjectives: "暂无目标。",
			panelObjRunning: "引擎运行中",
			panelObjPaused: "引擎已暂停",
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

		const panelStyles = {
			root: {
				display: "flex",
				flexDirection: "column",
				gap: "14px",
				padding: "12px 14px 18px",
				fontSize: "12.5px",
				lineHeight: 1.45,
				color: "inherit",
				height: "100%",
				boxSizing: "border-box",
				overflowY: "auto",
			},
			header: { display: "flex", alignItems: "center", gap: "8px" },
			title: { margin: 0, fontSize: "14px", fontWeight: 700, letterSpacing: "0.02em", flex: 1 },
			iconButton: {
				border: "1px solid rgba(127,127,127,0.35)",
				background: "transparent",
				color: "inherit",
				borderRadius: "6px",
				cursor: "pointer",
				fontSize: "12px",
				lineHeight: 1,
				padding: "4px 7px",
			},
			pill: {
				display: "inline-flex",
				alignItems: "center",
				borderRadius: "999px",
				padding: "2px 8px",
				fontSize: "10.5px",
				fontWeight: 700,
				letterSpacing: "0.06em",
				border: "1px solid currentColor",
				whiteSpace: "nowrap",
			},
			engine: { display: "grid", gridTemplateColumns: "auto 1fr", columnGap: "8px", rowGap: "2px", opacity: 0.72, fontSize: "11.5px" },
			sectionTitle: { margin: 0, fontSize: "10.5px", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6 },
			card: { border: "1px solid rgba(127,127,127,0.28)", borderRadius: "8px", padding: "8px 10px", display: "flex", flexDirection: "column", gap: "6px" },
			row: { display: "flex", alignItems: "baseline", gap: "8px", minWidth: 0 },
			badge: { fontSize: "10px", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", minWidth: "54px", flex: "none" },
			text: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			meta: { opacity: 0.6, fontSize: "10.5px", whiteSpace: "nowrap", flex: "none" },
			chip: { display: "inline-flex", alignItems: "center", gap: "4px", border: "1px solid rgba(127,127,127,0.3)", borderRadius: "999px", padding: "2px 8px", fontSize: "11px", whiteSpace: "nowrap" },
			hint: { margin: 0, opacity: 0.7, fontStyle: "italic" },
			error: { color: "#b3261e", fontStyle: "normal" },
			footer: { opacity: 0.6, fontSize: "10.5px", display: "flex", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" },
			mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "10.5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
		};

		const toneColor = (tone) => {
			if (tone === "ok") return "#1a7f37";
			if (tone === "warn") return "#9a6700";
			if (tone === "bad") return "#b3261e";
			if (tone === "accent") return "#2f6fed";
			return "rgba(127,127,127,0.9)";
		};

		const secondsAgo = (timestamp) => {
			if (typeof timestamp !== "number" || timestamp <= 0) return "—";
			const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
			if (seconds < 2) return "now";
			if (seconds < 60) return `${seconds}s`;
			return `${Math.round(seconds / 60)}m`;
		};

		const decisionLine = (entry) => {
			const decision = typeof entry?.decision === "string" ? entry.decision : "event";
			if (decision === "assign") {
				return {
					badge: "assign",
					tone: "accent",
					text: `${entry?.stage ?? "stage"} → ${entry?.persona ?? "persona"}`,
					meta: typeof entry?.latencyMs === "number" ? `${entry.latencyMs}ms` : "",
				};
			}
			if (decision === "selection") {
				const latency = typeof entry?.latencyMs === "number" ? `${entry.latencyMs}ms` : "";
				return {
					badge: "select",
					tone: "accent",
					text: `${entry?.allow ?? "?"} of ${entry?.categories ?? "?"} tool categories`,
					meta: latency,
				};
			}
			if (decision === "assessment" || decision === "policy" || decision === "loop") {
				const action = typeof entry?.action === "string" ? entry.action : decision === "loop" ? "repeat" : "?";
				const tone = action === "deny" || action === "cancel" || action === "repeat" ? "bad" : action === "ask" ? "warn" : "ok";
				const detail = entry?.reason ?? entry?.note ?? "";
				return {
					badge: decision === "policy" ? "policy" : decision === "loop" ? "loop" : "assess",
					tone,
					text: `${entry?.tool ?? "tool"} → ${action}`,
					meta: typeof detail === "string" ? detail.slice(0, 60) : "",
				};
			}
			return { badge: decision, tone: "neutral", text: "", meta: typeof entry?.at === "string" ? entry.at.slice(11, 19) : "" };
		};

		const counterLine = (stats) => {
			const s = stats !== null && typeof stats === "object" ? stats : {};
			return `${s.selections ?? 0} sel · ${s.assessments ?? 0} assess · ${s.loopDenials ?? 0} loop · ${s.asks ?? 0} ask · ${s.failures ?? 0} fail`;
		};

		const mountedSessionId = (ctx) => {
			try {
				const mounted = ctx.sidebarRight?.mounted?.getSnapshot?.();
				return typeof mounted === "string" ? mounted : undefined;
			} catch {
				return undefined;
			}
		};

		/**
		 * Poll the host snapshot and open the panel once when a swarm session appears.
		 * One poller per browser plugin instance keeps every open panel in sync.
		 */
		function createPanelPoller(ctx) {
			let snapshot = { status: "idle", data: undefined, error: undefined, updatedAt: 0 };
			const listeners = new Set();
			let timer;
			let disposed = false;
			let inflight = false;
			let autoOpenedFor;
			const emit = () => {
				for (const listener of [...listeners]) {
					try {
						listener();
					} catch {
						/* A panel render failure must not stop the poller. */
					}
				}
			};
			const publish = (next) => {
				snapshot = next;
				emit();
			};
			const maybeAutoOpen = (data) => {
				const active = typeof data?.swarm?.active === "number" ? data.swarm.active : 0;
				if (active <= 0) {
					autoOpenedFor = undefined;
					return;
				}
				const members = Array.isArray(data?.swarm?.members) ? data.swarm.members : [];
				const mounted = mountedSessionId(ctx);
				const isMember = mounted !== undefined && members.some((member) => member?.sessionId === mounted);
				const unknownMembers = members.some((member) => typeof member?.sessionId !== "string");
				const target = isMember || unknownMembers ? mounted : undefined;
				const key = target ?? "fallback";
				if (autoOpenedFor === key) return;
				autoOpenedFor = key;
				try {
					if (target !== undefined && typeof ctx.sidebarRight?.openTabIn === "function") ctx.sidebarRight.openTabIn(target, SWARM_KIND);
					else ctx.sidebarRight?.openTab?.(SWARM_KIND);
				} catch {
					/* No on-screen Session surface yet; the guide entry stays available. */
				}
			};
			const refresh = async () => {
				if (disposed || inflight) return;
				inflight = true;
				try {
					const base = typeof document !== "undefined" ? document.baseURI : undefined;
					if (base === undefined) throw new Error("no document");
					const response = await fetch(new URL(SWARM_PANEL_PATH, base), {
						credentials: "same-origin",
						cache: "no-store",
						headers: { accept: "application/json" },
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const data = await response.json();
					publish({ status: "ready", data, error: undefined, updatedAt: Date.now() });
					maybeAutoOpen(data);
				} catch (error) {
					publish({
						status: "error",
						data: snapshot.data,
						error: error instanceof Error ? error.message : String(error),
						updatedAt: snapshot.updatedAt,
					});
				} finally {
					inflight = false;
				}
			};
			const tick = () => {
				if (typeof document !== "undefined" && document.hidden) return;
				refresh();
			};
			const start = () => {
				if (timer !== undefined || disposed) return;
				refresh();
				timer = setInterval(tick, SWARM_POLL_MS);
				if (typeof document !== "undefined") document.addEventListener("visibilitychange", tick);
			};
			const dispose = () => {
				disposed = true;
				if (timer !== undefined) clearInterval(timer);
				timer = undefined;
				if (typeof document !== "undefined") document.removeEventListener("visibilitychange", tick);
				listeners.clear();
			};
			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				refresh,
				start,
				dispose,
			};
		}

		const sectionTitle = (title) => h("p", { style: panelStyles.sectionTitle }, title);

		/** The live swarm panel body inside the right sidebar. */
		function SwarmPanel(props) {
			const { poller, sessionId, collapse, t } = props;
			const [snapshot, setSnapshot] = React.useState(() => poller.getSnapshot());
			React.useEffect(() => poller.subscribe(() => setSnapshot(poller.getSnapshot())), [poller]);

			const data = snapshot.data;
			const active = typeof data?.swarm?.active === "number" ? data.swarm.active : 0;
			const members = Array.isArray(data?.swarm?.members) ? data.swarm.members : [];
			const personas = Array.isArray(data?.swarm?.personas) ? data.swarm.personas : [];
			const recent = Array.isArray(data?.recent) ? data.recent : [];
			const engine = data?.engine !== null && typeof data?.engine === "object" ? data.engine : {};
			const stats = data?.stats !== null && typeof data?.stats === "object" ? data.stats : {};
			const objectives = data?.objectives;
			const objectiveCounts = objectives?.counts ?? {};
			const objectiveRows = Array.isArray(objectives?.objectives) ? objectives.objectives : [];
			const assignments = new Map();
			for (const entry of recent) {
				if (entry?.decision === "assign" && typeof entry.persona === "string") {
					assignments.set(entry.persona, (assignments.get(entry.persona) ?? 0) + 1);
				}
			}

			return h(
				"div",
				{ style: panelStyles.root },
				h(
					"div",
					{ style: panelStyles.header },
					h("h2", { style: panelStyles.title }, t("panelTitle")),
					h("span", { style: { ...panelStyles.pill, color: active > 0 ? "#1a7f37" : "rgba(127,127,127,0.9)" } }, active > 0 ? t("panelActive") : t("panelIdle")),
					h("button", { type: "button", title: t("panelRefresh"), style: panelStyles.iconButton, onClick: () => poller.refresh() }, "⟳"),
					h("button", { type: "button", title: t("panelCollapse"), style: panelStyles.iconButton, onClick: () => { try { collapse(); } catch { /* no surface */ } } }, "»"),
				),
				h(
					"div",
					{ style: panelStyles.engine },
					h("span", null, t("panelMode")),
					h("span", { style: panelStyles.mono }, typeof engine.mode === "string" ? engine.mode : "—"),
					h("span", null, t("panelModel")),
					h("span", { style: panelStyles.mono }, typeof engine.model === "string" ? engine.model : "—"),
					h("span", null, t("panelEndpoint")),
					h("span", { style: panelStyles.mono }, typeof engine.endpoint === "string" ? engine.endpoint : "—"),
				),
				snapshot.status === "idle" ? h("p", { style: panelStyles.hint }, t("panelConnecting")) : null,
				snapshot.status === "error" ? h("p", { style: { ...panelStyles.hint, ...panelStyles.error } }, `${t("panelUnavailable")} ${snapshot.error ?? ""}`) : null,
				sectionTitle(t("panelSessions")),
				active === 0
					? h(
							"div",
							{ style: panelStyles.card },
							h("p", { style: { margin: 0 } }, t("panelNoSwarm")),
							h("p", { style: panelStyles.hint }, t("panelNoSwarmHint")),
						)
					: h(
							"div",
							{ style: { ...panelStyles.card, gap: "4px" } },
							members.map((member, index) =>
								h(
									"div",
									{ key: `${member?.sessionId ?? "unknown"}-${index}`, style: panelStyles.row },
									h("span", { style: panelStyles.chip }, typeof member?.preset === "string" ? member.preset : "—"),
									h("span", { style: { ...panelStyles.mono, flex: 1 } }, typeof member?.sessionId === "string" ? member.sessionId : t("panelSession")),
									member?.sessionId === sessionId ? h("span", { style: { ...panelStyles.chip, opacity: 0.75 } }, t("panelThisSession")) : null,
								),
							),
						),
				sectionTitle(t("panelPersonas")),
				h(
					"div",
					{ style: { display: "flex", flexWrap: "wrap", gap: "6px" } },
					personas.map((persona) =>
						h(
							"span",
							{ key: persona.id, style: panelStyles.chip, title: typeof persona.description === "string" ? persona.description : "" },
							`${persona.id}${assignments.get(persona.id) ? ` ×${assignments.get(persona.id)}` : ""}`,
						),
					),
				),
				objectives !== undefined
					? h(
							React.Fragment,
							null,
							sectionTitle(t("panelObjectives")),
							h(
								"div",
								{ style: { ...panelStyles.card, gap: "6px" } },
								h(
									"div",
									{ style: { display: "flex", flexWrap: "wrap", gap: "6px" } },
									h("span", { style: panelStyles.chip }, t(objectives.paused ? "panelObjPaused" : "panelObjRunning")),
									h("span", { style: panelStyles.chip }, `active ${objectiveCounts.active ?? 0}`),
									h("span", { style: panelStyles.chip }, `queued ${objectiveCounts.queued ?? 0}`),
									h("span", { style: panelStyles.chip }, `blocked ${objectiveCounts.blocked ?? 0}`),
									h("span", { style: panelStyles.chip }, `completed ${objectiveCounts.completed ?? 0}`),
								),
								objectiveRows.length === 0
									? h("p", { style: panelStyles.hint }, t("panelNoObjectives"))
									: objectiveRows.map((objective) =>
											h(
												"div",
												{ key: objective.id, style: panelStyles.row },
												h(
													"span",
													{
														style: {
															...panelStyles.badge,
															color: toneColor(objective.state === "active" ? "accent" : objective.state === "blocked" ? "bad" : "neutral"),
														},
													},
													objective.state,
												),
												h("span", { style: panelStyles.text, title: objective.statement }, objective.statement),
												h("span", { style: panelStyles.meta }, `${objective.rounds}/${objective.maxRounds}`),
											),
										),
							),
						)
					: null,
				sectionTitle(t("panelOperations")),
				recent.length === 0
					? h("p", { style: panelStyles.hint }, t("panelNoOps"))
					: h(
							"div",
							{ style: { ...panelStyles.card, gap: "5px" } },
							recent
								.slice()
								.reverse()
								.slice(0, 12)
								.map((entry, index) => {
									const line = decisionLine(entry);
									return h(
										"div",
										{ key: `${entry?.at ?? "t"}-${index}`, style: panelStyles.row },
										h("span", { style: { ...panelStyles.badge, color: toneColor(line.tone) } }, line.badge),
										h("span", { style: panelStyles.text }, line.text),
										h("span", { style: panelStyles.meta }, line.meta),
									);
								}),
						),
				h(
					"div",
					{ style: panelStyles.footer },
					h("span", null, counterLine(stats)),
					h("span", null, `${t("panelUpdated")} ${secondsAgo(snapshot.updatedAt)}`),
				),
			);
		}

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
		const inject = ["slots", "locale", "remote", "remote.credentials", "configForms", "sidebarRight", "sidebarRightTabs"];

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

			// Live swarm panel in the right sidebar: a collapsible tab beside
			// files/browser/terminal, fed by the authenticated snapshot route.
			const panelPoller = createPanelPoller(ctx);
			ctx.effect(() => {
				panelPoller.start();
				return () => panelPoller.dispose();
			}, "systemone-settings: swarm poller");
			ctx.effect(
				() =>
					ctx.sidebarRightTabs.register({
						id: SWARM_TAB_ID,
						kind: SWARM_KIND,
						title: () => t("panelTitle"),
						guide: [
							{
								id: "swarm",
								order: 40,
								title: () => t("panelGuideTitle"),
								description: () => t("panelGuideDescription"),
							},
						],
					}),
				"systemone-settings: swarm tab type",
			);
			ctx.effect(
				() =>
					ctx.slots.inject("sidebar.right.pane.tab", () =>
						ctx.slots.register(
							{
								name: "sidebar.right.pane.tab",
								key: SWARM_TAB_ID,
								locale: NS,
								inject: (sessionId) => ({
									poller: panelPoller,
									sessionId,
									t,
									collapse: () => ctx.sidebarRight.toggleExpanded(),
								}),
							},
							SwarmPanel,
						),
					),
				"systemone-settings: swarm panel body",
			);
		}

		exports.inject = inject;
		exports.apply = apply;
		exports.NS = NS;
		exports.ENTRY_ID = ENTRY_ID;
		return module.exports;
	},
});
