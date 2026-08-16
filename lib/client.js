window.__ModuleLoader__.load({
	id: "dsh-llm-grok-oauth",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const jsx = require("react/jsx-runtime");
		const react = require("react");
		const reactDom = require("react-dom");

		const css = [
			".gkx_mount{border-top:1px solid var(--dsw-alias-border-l2);margin-top:4px;padding-top:12px;display:flex;flex-direction:column;gap:10px}",
			".gkx_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}",
			".gkx_msg{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px;line-height:1.5}",
			".gkx_err{color:var(--dsw-alias-label-error);margin:0;font-size:13px;line-height:1.5}",
			".gkx_code{font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.08em;font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary)}",
			".gkx_row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
			".gkx_primary,.gkx_ghost{appearance:none;font:inherit;cursor:pointer;border-radius:8px;padding:6px 14px;font-size:13px;line-height:1.5}",
			".gkx_primary{border:1px solid transparent;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}",
			".gkx_ghost{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}",
			".gkx_primary:disabled,.gkx_ghost:disabled{opacity:.4;cursor:default}",
			".gkx_link{color:var(--dsw-alias-brand-primary);font-size:13px}",
		].join("");
		const tagId = "dsh-llm-grok-oauth/models.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-llm-grok-oauth";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const NS = "settings.plugin.grok";
		const SETTINGS_NS = "llm-grok";
		const ROW_MARKERS = ["Grok (xAI 订阅)", "GROK OAUTH"];

		const en = {
			login: "Sign in with Grok",
			logout: "Sign out",
			opening: "Complete sign-in in the browser window that just opened.",
			userCode: "Confirmation code",
			openUrl: "Open sign-in page",
		};
		const zh = {
			login: "使用 Grok 账号登录",
			logout: "退出登录",
			opening: "请在刚打开的浏览器窗口中完成授权。",
			userCode: "确认代码",
			openUrl: "打开登录页",
		};

		function createStore(initial) {
			let value = initial;
			const listeners = new Set();
			return {
				getSnapshot: () => value,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				set: (next) => {
					value = next;
					for (const listener of listeners) listener();
				},
			};
		}

		function findGrokRow() {
			const buttons = document.querySelectorAll("button");
			for (const button of buttons) {
				const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`;
				if (!ROW_MARKERS.some((marker) => label.includes(marker))) continue;
				const row = button.closest("li");
				if (row) return row;
			}
			const items = document.querySelectorAll("li");
			for (const item of items) {
				const text = item.textContent || "";
				if (ROW_MARKERS.some((marker) => text.includes(marker))) return item;
			}
			return null;
		}

		function hideGenericEditor(row) {
			for (const node of row.querySelectorAll("p")) {
				const text = node.textContent || "";
				if (!text.includes("settings.yaml") && !text.includes("llm-grok")) continue;
				let block = node.parentElement;
				while (block && block !== row && block.tagName !== "LI") {
					if (block.querySelector("button")) {
						block.style.display = "none";
						break;
					}
					block = block.parentElement;
				}
			}
		}

		function LoginBody(props) {
			const { t } = props;
			const state = props.useGrokCard((snapshot) => snapshot);
			const openedUrl = react.useRef("");

			react.useEffect(() => {
				if (state.oauthStatus === "pending" && state.verificationUrl && openedUrl.current !== state.verificationUrl) {
					openedUrl.current = state.verificationUrl;
					try { window.open(state.verificationUrl, "_blank", "noopener,noreferrer"); } catch { /* host already opened */ }
				}
			}, [state.oauthStatus, state.verificationUrl]);

			if (!state.available) return null;
			const signedIn = state.oauthStatus === "signed-in";
			const pending = state.oauthStatus === "pending";
			return jsx.jsxs("div", {
				className: "gkx_mount",
				children: [
					state.oauthMessage
						? jsx.jsx("p", {
							className: state.oauthStatus === "error" ? "gkx_err" : "gkx_msg",
							children: state.oauthMessage,
						})
						: null,
					pending && state.userCode
						? jsx.jsxs("p", {
							className: "gkx_msg",
							children: [t("userCode"), ": ", jsx.jsx("span", { className: "gkx_code", children: state.userCode })],
						})
						: null,
					pending ? jsx.jsx("p", { className: "gkx_hint", children: t("opening") }) : null,
					pending && state.verificationUrl
						? jsx.jsx("a", {
							className: "gkx_link",
							href: state.verificationUrl,
							target: "_blank",
							rel: "noreferrer",
							children: t("openUrl"),
						})
						: null,
					jsx.jsxs("div", {
						className: "gkx_row",
						children: [
							jsx.jsx("button", {
								type: "button",
								className: "gkx_primary",
								disabled: !state.writable || pending,
								onClick: () => { props.login(); },
								children: t("login"),
							}),
							signedIn ? jsx.jsx("button", {
								type: "button",
								className: "gkx_ghost",
								disabled: !state.writable || pending,
								onClick: () => { props.logout(); },
								children: t("logout"),
							}) : null,
						],
					}),
				],
			});
		}

		function ModelsPortal(props) {
			const [row, setRow] = react.useState(null);
			const mountRef = react.useRef(null);

			react.useEffect(() => {
				const ensureMount = (host) => {
					if (!host) return null;
					hideGenericEditor(host);
					let mount = host.querySelector(":scope > .gkx_mount_host");
					if (mount === null) {
						mount = document.createElement("div");
						mount.className = "gkx_mount_host";
						host.appendChild(mount);
					}
					mountRef.current = mount;
					return host;
				};
				const scan = () => setRow(ensureMount(findGrokRow()));
				scan();
				const observer = new MutationObserver(scan);
				observer.observe(document.body, { childList: true, subtree: true });
				return () => observer.disconnect();
			}, []);

			if (row === null || mountRef.current === null) return null;
			return reactDom.createPortal(jsx.jsx(LoginBody, props), mountRef.current);
		}

		const inject = ["slots", "locale", "connection", "remote", "settingsScope"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-llm-grok: dictionaries");
			const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS });
			const store = createStore(project(scope));
			scope.subscribe(() => store.set(project(scope)));

			ctx.slots.inject("settings.action", () => ctx.slots.register({
				name: "settings.action",
				id: "llm-grok-models-login",
				order: 80,
				locale: NS,
				inject: () => ({
					hooks: { grokCard: store },
					login: () => scope.set("oauthAction", "login"),
					logout: () => scope.set("oauthAction", "logout"),
				}),
			}, ModelsPortal));
		}

		function project(scope) {
			const snapshot = scope.getSnapshot();
			const value = snapshot.value || {};
			return {
				available: snapshot.status === "ready",
				writable: snapshot.writable !== false,
				oauthStatus: value.oauthStatus || "signed-out",
				verificationUrl: value.verificationUrl || "",
				userCode: value.userCode || "",
				oauthMessage: value.oauthMessage || "",
			};
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
