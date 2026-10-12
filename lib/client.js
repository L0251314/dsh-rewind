window.__ModuleLoader__.load({
	id: "dsh-rewind",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		// ============================================================================
		// dsh-rewind —— Client 半（Web UI）
		// ============================================================================
		// 在 conversation.chat.turnTail（每轮完成 Turn 的动作行前扩展区）注入撤回图标。
		// 点击 → /dsh-rewind/api/plan 拉取受影响文件清单 → 内联确认 → restore →
		// 成功后 uiWorkspace.openSession(分叉会话)。
		//
		// 官方工厂信封格式（参照 @deepseek-ai/dsh-client-ui-chat/lib/client.js）：
		//   window.__ModuleLoader__.load({ id, factory(require) → exports })
		// React 来自平台静态模块表；shell 会在物化时以客户端 ctx 调用 exports.apply。
		// ============================================================================
		var React = null;
		try { React = require("react"); } catch (err) { console.error("[dsh-rewind] react 不可用，撤回图标将不渲染", err); }

		var ROUTE = "/dsh-rewind/api";
		var cssInserted = false;
		function ensureStyles() {
			if (cssInserted) return;
			cssInserted = true;
			try {
				var style = document.createElement("style");
				style.textContent = "\n.dsh-rewind-wrap{display:inline-flex;align-items:center;position:relative}\n.dsh-rewind-btn{display:inline-flex;align-items:center;gap:4px;border:1px solid transparent;border-radius:6px;\n  background:transparent;color:var(--dsh-fg-muted,#888);cursor:pointer;font-size:12px;line-height:1;\n  padding:3px 6px;opacity:.55;transition:opacity .12s ease,background .12s ease}\n.dsh-rewind-btn:hover{opacity:1;background:var(--dsh-bg-hover,rgba(128,128,128,.12));color:inherit}\n.dsh-rewind-btn[disabled]{opacity:.35;cursor:default}\n.dsh-rewind-pop{position:absolute;bottom:calc(100% + 6px);left:0;z-index:60;width:340px;max-height:280px;overflow:auto;\n  border:1px solid var(--dsh-border,rgba(128,128,128,.35));border-radius:10px;padding:10px 12px;\n  background:var(--dsh-bg,#1e1e1e);color:inherit;box-shadow:0 8px 24px rgba(0,0,0,.35);font-size:12px}\n.dsh-rewind-pop h4{margin:0 0 6px;font-size:12px;font-weight:600}\n.dsh-rewind-pop ul{margin:4px 0 8px;padding-left:16px;max-height:120px;overflow:auto}\n.dsh-rewind-pop li{margin:1px 0;word-break:break-all}\n.dsh-rewind-pop .st-M{color:#e2b341}.dsh-rewind-pop .st-D{color:#e2574b}.dsh-rewind-pop .st-A{color:#5bb98b}\n.dsh-rewind-actions{display:flex;gap:8px;justify-content:flex-end}\n.dsh-rewind-actions button{border-radius:6px;border:1px solid var(--dsh-border,rgba(128,128,128,.35));\n  background:transparent;color:inherit;padding:3px 10px;cursor:pointer;font-size:12px}\n.dsh-rewind-actions button.primary{background:var(--dsh-accent,#4c7dff);border-color:transparent;color:#fff}\n.dsh-rewind-err{color:#e2574b;margin:4px 0 0;white-space:pre-wrap}\n.dsh-rewind-ok{color:#5bb98b;margin:4px 0 0}\n";
				(document.head || document.documentElement).appendChild(style);
			} catch (err) { /* 无 DOM 时跳过美化 */ }
		}

		function api(path, body) {
			return fetch(ROUTE + path, {
				method: body === undefined ? "GET" : "POST",
				headers: body === undefined ? undefined : { "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			}).then(function (res) {
				return res.json().catch(function () { return {}; }).then(function (data) {
					if (!res.ok || data.ok === false) throw new Error(data.error || data.message || ("HTTP " + res.status));
					return data;
				});
			});
		}

		function statusClass(st) { return st === "M" ? "st-M" : st === "D" ? "st-D" : st === "A" ? "st-A" : ""; }
		// diff 方向 = 当前树 → 检查点树（回退将发生什么）：M 还原 / D 移除后建的 / A 恢复被删的
		var STATUS_LABEL = { M: "还原", D: "移除", A: "恢复" };

		var debugLogged = false
		function RewindButton(props) {
			var turn = props.turn;
			var sessionId = props.sessionId || (props.session && props.session.id) || null;
			var R = React;
			if (!debugLogged) {
				debugLogged = true
				try {
					var propKeys = [];
					for (var k in (props || {})) propKeys.push(k + ":" + typeof props[k]);
					console.log("[dsh-rewind] turnTail 组件渲染，props = { " + propKeys.join(", ") + " }");
					console.log("[dsh-rewind] turn=" + turn + " sessionId=" + JSON.stringify(sessionId));
				} catch (err) { /* ignore */ }
			}
			if (!R || typeof turn !== "number") return null;
			// sessionId 缺失时仍渲染（禁用态），避免静默消失无法排查
			var canAct = !!sessionId

			var state = R.useState("idle"); // idle | loading | confirm | running | done | error
			var phase = state[0], setPhase = state[1];
			var planState = R.useState(null);
			var plan = planState[0], setPlan = planState[1];
			var msgState = R.useState("");
			var message = msgState[0], setMessage = msgState[1];
			var childState = R.useState(null);
			var childId = childState[0], setChildId = childState[1];

			function openPlan() {
				setPhase("loading");
				api("/plan?sessionId=" + encodeURIComponent(sessionId) + "&turn=" + turn).then(function (data) {
					setPlan(data);
					setPhase("confirm");
				}).catch(function (err) {
					setMessage(String(err.message || err));
					setPhase("error");
				});
			}

			function doRestore() {
				setPhase("running");
				api("/restore", { sessionId: sessionId, turn: turn }).then(function (result) {
					if (result.ok) {
						setChildId(result.childSessionId || null);
						setPhase("done");
						try {
							if (result.childSessionId && typeof ctx !== "undefined") {
								var uw = ctx.get ? ctx.get("uiWorkspace") : null;
								if (uw && uw.openSession) uw.openSession(result.childSessionId);
							}
						} catch (err) { /* 跳转失败不提示致命错误 */ }
					} else {
						setMessage(result.message || "回退失败");
						setPhase("error");
					}
				}).catch(function (err) {
					setMessage(String(err.message || err));
					setPhase("error");
				});
			}

			var busy = phase === "loading" || phase === "running";

			function onBtnClick(e) {
				e.stopPropagation();
				if (phase === "idle" || phase === "error") openPlan();
				else if (phase === "confirm" || phase === "done") setPhase("idle");
			}

			var kids = [];
			kids.push(R.createElement("button", {
				key: "btn",
				className: "dsh-rewind-btn",
				title: canAct ? ("回退到第 " + turn + " 轮之前（代码 + 对话）") : "无法确定当前会话（sessionId 缺失）",
				disabled: busy || !canAct,
				onClick: onBtnClick,
			}, "↩ 回退本轮"));

			if (phase === "confirm" && plan) {
				var files = plan.files || [];
				var counts = plan.counts || {};
				var listItems = files.slice(0, 50).map(function (f, i) {
					return R.createElement("li", { key: i },
						R.createElement("span", { className: statusClass(f.status) }, "[" + (STATUS_LABEL[f.status] || f.status) + "] "),
						f.path);
				});
				kids.push(R.createElement("div", { key: "pop", className: "dsh-rewind-pop" }, [
					R.createElement("h4", { key: "h" }, "回退到第 " + turn + " 轮之前（还原 " + (counts.modified || 0) + " / 移除 " + (counts.deleted || 0) + " / 恢复 " + (counts.added || 0) + "）"),
					files.length > 0
						? R.createElement("ul", { key: "l" }, listItems)
						: R.createElement("div", { key: "e" }, "（无文件差异）"),
					R.createElement("div", { key: "note", style: { opacity: .7 } }, "当前状态会先保存安全点，可再次回退反悔。"),
					R.createElement("div", { key: "a", className: "dsh-rewind-actions" }, [
						R.createElement("button", { key: "c", onClick: function () { setPhase("idle"); } }, "取消"),
						R.createElement("button", { key: "ok", className: "primary", disabled: busy, onClick: function () { doRestore(); } }, busy ? "回退中…" : "确认回退"),
					]),
				]));
			}
			if (phase === "error") {
				kids.push(R.createElement("div", { key: "err", className: "dsh-rewind-err" }, "回退失败：" + message));
			}
			if (phase === "done") {
				kids.push(R.createElement("div", { key: "ok", className: "dsh-rewind-ok" }, childId
					? "✅ 已回退并分叉新会话"
					: "✅ 已回退（会话分叉不可用，代码已恢复）"));
			}

			return R.createElement("span", { className: "dsh-rewind-wrap" }, kids);
		}

		function apply(ctx) {
			var done = false
			var tries = 0
			function attempt() {
				if (done) return
				if (tries >= 10) {
					console.error("[dsh-rewind] slot 注册重试超限，放弃。最后错误已见上方日志（请把这段控制台输出发回）")
					return
				}
				tries++
				try {
					if (!ctx || !ctx.slots || !ctx.slots.inject || !ctx.slots.register) {
						console.error("[dsh-rewind] ctx.slots 不可用，撤回图标未注册")
						return
					}
					ctx.slots.inject("conversation.chat.turnTail", function () {
						return ctx.slots.register({
							name: "conversation.chat.turnTail",
							id: "dsh-rewind.undo",
							order: 0,
							label: "回退本轮（代码+对话）",
						}, RewindButton)
					})
					done = true
					console.log("[dsh-rewind] 撤回图标已注册（turnTail）")
				} catch (err) {
					// 目标 slot 可能尚未被聊天插件声明（加载顺序），0.5s 后重试；
					// 前两次把真实错误打出来，便于定位（键名/声明格式/上下文不对等问题）
					if (tries <= 2) {
						console.error("[dsh-rewind] slot 注册第 " + tries + " 次失败：", (err && (err.stack || err.message)) || err)
					}
					setTimeout(attempt, 500)
				}
			}
			attempt()
		}

		// 受保护客户端上下文要求：服务属性访问必须声明 inject（同款见 ui-chat client.js L12258）
		module.exports.inject = ["slots", "uiWorkspace"];
		module.exports.apply = apply;
		return module.exports;
	}
});
