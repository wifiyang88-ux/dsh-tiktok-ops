/**
 * TikTok 运营助手 — 客户端侧（browser half）
 *
 * 手写的 ModuleLoader bundle，只依赖 react。落地页挂在「设置 → TikTok 运营助手」。
 * 页签：任务 / 数据 / 评论 / 洞察 / 设置
 */
window.__ModuleLoader__.load({
	id: "dsh-tiktok-ops",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react = require("react");

		const API = "/api/tiktok-ops";
		const SECTION_ORDER = 160;
		const h = react.createElement;

		// ------------------------------------------------------------ 基础

		async function api(path, body, method) {
			const m = method ?? (body === undefined ? "GET" : "POST");
			const response = await fetch(API + path, {
				method: m,
				...(m === "POST" ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) } : {})
			});
			const text = await response.text();
			let parsed;
			try {
				parsed = text ? JSON.parse(text) : {};
			} catch {
				parsed = { ok: false, error: text.slice(0, 300) };
			}
			if (!response.ok) throw new Error(parsed.error || `HTTP ${response.status}`);
			if (parsed.ok === false) {
				// 失败响应也带 state（服务端可能已经改过状态，比如生成失败退回脚本审核），
				// 把它挂在 error 上，让 store.run 顺手把界面同步过来。
				const err = new Error(parsed.error || "接口返回失败");
				err.state = parsed.state ?? null;
				throw err;
			}
			return parsed;
		}

		const T = {
			muted: { opacity: 0.62 },
			card: {
				border: "1px solid var(--dsh-color-border, rgba(128,128,128,.28))",
				borderRadius: "10px",
				padding: "14px",
				display: "flex",
				flexDirection: "column",
				gap: "10px"
			},
			sub: {
				border: "1px solid var(--dsh-color-border, rgba(128,128,128,.22))",
				borderRadius: "8px",
				padding: "10px",
				display: "flex",
				flexDirection: "column",
				gap: "7px"
			},
			input: {
				width: "100%",
				boxSizing: "border-box",
				padding: "7px 9px",
				borderRadius: "7px",
				border: "1px solid var(--dsh-color-border, rgba(128,128,128,.35))",
				background: "var(--dsh-color-surface, transparent)",
				color: "inherit",
				font: "inherit"
			},
			btn: {
				padding: "6px 12px",
				borderRadius: "7px",
				border: "1px solid var(--dsh-color-border, rgba(128,128,128,.35))",
				background: "var(--dsh-color-surface, transparent)",
				color: "inherit",
				cursor: "pointer",
				font: "inherit",
				fontSize: "13px"
			},
			btnPrimary: {
				padding: "6px 12px",
				borderRadius: "7px",
				border: "1px solid transparent",
				background: "var(--dsh-color-accent, #4c8dff)",
				color: "#fff",
				cursor: "pointer",
				font: "inherit",
				fontSize: "13px"
			},
			row: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
			grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: "10px" },
			label: { fontSize: "12px", opacity: 0.62 },
			pre: {
				margin: 0,
				padding: "9px",
				borderRadius: "7px",
				background: "rgba(128,128,128,.1)",
				fontSize: "12px",
				overflow: "auto",
				maxHeight: "200px",
				whiteSpace: "pre-wrap"
			},
			tag: {
				fontSize: "11px",
				padding: "2px 7px",
				borderRadius: "999px",
				border: "1px solid var(--dsh-color-border, rgba(128,128,128,.35))"
			}
		};

		const STATUS_ORDER = ["draft", "working", "script_review", "video_review", "ready", "published"];
		const STATUS_STYLE = {
			draft: { opacity: 0.7 },
			working: { borderColor: "var(--dsh-color-accent, #4c8dff)", color: "var(--dsh-color-accent, #4c8dff)" },
			script_review: { borderColor: "#d9a441", color: "#d9a441" },
			video_review: { borderColor: "#d9a441", color: "#d9a441" },
			ready: { borderColor: "#30a46c", color: "#30a46c" },
			published: { opacity: 0.75 }
		};

		const ASPECT_LABEL = { portrait: "竖屏 9:16", landscape: "横屏 16:9", square: "方形 1:1" };

		/**
		 * MiniMax H3 的档位表（与 lib/minimax.js 保持一致）。
		 * 客户端单独放一份是为了让设置页能在选中模型时立刻过滤分辨率选项，
		 * 不用为一次下拉去问服务端。
		 */
		const MM_MODELS = {
			"MiniMax-H3": { label: "MiniMax-H3", resolutions: ["768P", "2K"], minDuration: 4, maxDuration: 15 },
			"MiniMax-H3-Max": { label: "MiniMax-H3-Max（极速）", resolutions: ["480P", "768P"], minDuration: 5, maxDuration: 15 }
		};
		const PROVIDER_OPTIONS = [
			{ key: "guben", label: "顾本素材库" },
			{ key: "minimax", label: "MiniMax-H3" }
		];
		/**
		 * MiniMax 分国内 / 国际两套平台，**API Key 不通用**，域名也不一样。
		 * 填错区的典型症状就是「Token 保存成功但调用一律 401」，所以把域名做成显式选项。
		 */
		const MM_BASES = [
			{ value: "https://api.minimax.cn", label: "国内 · api.minimax.cn" },
			{ value: "https://api.minimax.io", label: "国际 · api.minimax.io" }
		];

		function Btn(props) {
			const style = props.primary ? T.btnPrimary : T.btn;
			return h(
				"button",
				{
					type: "button",
					style: { ...style, ...(props.disabled ? { opacity: 0.45, cursor: "not-allowed" } : {}) },
					disabled: props.disabled,
					onClick: props.onClick
				},
				props.children
			);
		}

		function Banner(props) {
			if (!props.text) return null;
			return h(
				"div",
				{
					style: {
						fontSize: "12px",
						padding: "8px 10px",
						borderRadius: "7px",
						background: props.kind === "err" ? "rgba(229,72,77,.12)" : "rgba(48,164,108,.12)",
						color: props.kind === "err" ? "var(--dsh-color-danger, #e5484d)" : "var(--dsh-color-success, #30a46c)"
					}
				},
				props.text
			);
		}

		function Field(props) {
			return h(
				"label",
				{ style: { display: "flex", flexDirection: "column", gap: "4px", flex: props.flex ?? "1 1 140px" } },
				h("span", { style: T.label }, props.label),
				props.children
			);
		}

		/**
		 * 任务详情弹窗里的一行「标签 + 内容」。
		 *
		 * ⚠️ 必须定义在**模块作用域**。以前它写在 TaskDetailModal 里面，
		 * 于是每次渲染都会创建一个新的函数对象；React 按「组件类型引用」做协调，
		 * 引用一变就当成另一个组件，把整棵子树卸载重建 —— 表现就是
		 * 「输入框里打一个字，光标就被踢出去」。任何带输入控件的子组件都不能这样内联定义。
		 */
		function Row(props) {
			return h(
				"div",
				{ style: { display: "grid", gridTemplateColumns: "108px 1fr", gap: "10px", alignItems: "start", fontSize: "13px" } },
				h("span", { style: { ...T.label, paddingTop: "2px" } }, props.label),
				h("div", { style: { minWidth: 0, wordBreak: "break-word" } }, props.children)
			);
		}

		/** 参考素材：每行一个，按内容猜类型，省得反复点选。 */
		function parseRefs(text) {
			return String(text ?? "")
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
				.map((value) => {
					let kind = "text";
					if (/^\d+$/.test(value)) kind = "guben";
					else if (/^https?:\/\//i.test(value)) {
						if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(value)) kind = "image";
						else if (/\.(mp4|mov|webm|m4v)(\?|$)/i.test(value)) kind = "video";
						else kind = "url";
					}
					return { kind, value };
				});
		}

		const REF_LABEL = { guben: "顾本素材", image: "图片", video: "视频", url: "网页", text: "文本" };

		// ------------------------------------------------------------ 任务

		/** 按扩展名判断一个地址指向图片还是视频（顾本的预签名地址带查询串）。 */
		function fileKindOf(url) {
			const value = String(url ?? "");
			if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(value)) return "image";
			if (/\.(mp4|mov|webm|m4v)(\?|$)/i.test(value)) return "video";
			return null;
		}

		/**
		 * 素材预览：图片直接显示、视频给播放器、网页给链接。
		 * 本地路径不能直接被浏览器加载，所以走宿主的 /file 接口（那个接口有任务素材白名单）。
		 * 顾本素材（作品 / 公共库）在任务里存的是 id，得靠缩略图与预览地址：
		 * 视频用 previewUrl 播、thumbUrl 当封面；只有封面时退化成一张图，别硬塞给 video。
		 */
		function MaterialRow(props) {
			const { item, onRemove, muted = false, size = "thumb" } = props;
			const value = String(item?.value ?? "");
			const kind = item?.kind ?? "";
			const isUrl = /^https?:\/\//i.test(value);
			const localPath =
				typeof item?.path === "string" && item.path.startsWith("/") ? item.path : value.startsWith("/") ? value : null;
			const localSrc = localPath ? API + "/file?path=" + encodeURIComponent(localPath) : null;
			const thumb = typeof item?.thumbUrl === "string" && item.thumbUrl ? item.thumbUrl : null;
			// 真正能播 / 能显示的候选地址，按可信度排序
			const candidates = [item?.previewUrl, isUrl ? value : null, localSrc].filter(Boolean);
			const videoSrc = candidates.find((u) => fileKindOf(u) === "video") ?? null;
			const imageSrc = (fileKindOf(thumb) === "image" ? thumb : null) ?? candidates.find((u) => fileKindOf(u) === "image") ?? null;
			const hint = item?.mediaKind || item?.type || kind;
			const wantsVideo = hint === "video" || (hint !== "image" && Boolean(videoSrc));
			const wantsImage = !wantsVideo && (hint === "image" || Boolean(imageSrc));
			const border = "1px solid var(--dsh-color-border, rgba(128,128,128,.25))";
			// 成片要能看清、听清：竖屏 9:16 如果按缩略图那样限高 160px，宽度只剩 90px，根本没法审片
			const videoStyle =
				size === "full"
					? { maxWidth: "260px", maxHeight: "440px", borderRadius: "8px", display: "block", background: "#000" }
					: { maxWidth: "240px", maxHeight: "160px", borderRadius: "6px", display: "block" };

			const media =
				wantsVideo && videoSrc
					? h("video", {
							src: videoSrc,
							poster: fileKindOf(thumb) === "image" ? thumb : undefined,
							controls: true,
							// 别默认静音：这里播的是**成片**，审片就是要听声音的。
							// （之前写死 muted:true，导致 H3 生成出来的有声视频在详情页放着没声音。）
							muted: Boolean(muted),
							preload: "metadata",
							style: videoStyle
						})
					: imageSrc && (wantsVideo || wantsImage)
						? h("img", { src: imageSrc, alt: value, style: { maxWidth: "170px", maxHeight: "120px", borderRadius: "6px", display: "block", border } })
						: null;

			return h(
				"div",
				{ style: { ...T.sub, gap: "7px", padding: "9px" } },
				h(
					"div",
					{ style: { ...T.row, gap: "8px", fontSize: "12px" } },
					h("span", { style: T.tag }, REF_LABEL[kind] ?? kind),
					item?.title ? h("span", { style: { fontWeight: 600 } }, item.title) : null,
					isUrl
						? h("a", { href: value, target: "_blank", rel: "noreferrer", style: { wordBreak: "break-all" } }, value)
						: h("span", { style: { wordBreak: "break-all", ...T.muted } }, value),
					h("span", { style: { flex: 1 } }),
					onRemove ? h("span", { style: { cursor: "pointer", ...T.muted }, onClick: onRemove }, "移除") : null
				),
				media
			);
		}

		/** 弹窗外壳：新建任务用它，而不是常驻表单。 */
		function Modal(props) {
			if (!props.open) return null;
			return h(
				"div",
				{
					style: {
						position: "fixed",
						inset: 0,
						background: "rgba(0,0,0,.55)",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						zIndex: 1000
					},
					onClick: props.onClose
				},
				h(
					"div",
					{
						style: {
							width: "min(700px, 92vw)",
							maxHeight: "86vh",
							overflow: "auto",
							background: "var(--dsh-color-bg-elevated, #232327)",
							border: "1px solid var(--dsh-color-border, rgba(128,128,128,.3))",
							borderRadius: "12px",
							padding: "18px",
							display: "flex",
							flexDirection: "column",
							gap: "12px",
							boxShadow: "0 18px 48px rgba(0,0,0,.45)"
						},
						onClick: (e) => e.stopPropagation()
					},
					h(
						"div",
						{ style: { ...T.row } },
						h("strong", { style: { fontSize: "15px" } }, props.title),
						h("span", { style: { flex: 1 } }),
						h(Btn, { onClick: props.onClose }, "关闭")
					),
					props.children
				)
			);
		}

		/** 素材来源页签：都来自顾本，第三条只是「先上传再引用」。 */
		const PICKER_TABS = [
			{ id: "works", label: "我的作品", hint: "顾本「我的作品」。本地上传的素材也进这里，生成时用 private scope。" },
			{ id: "materials", label: "公共素材（已下载）", hint: "只列已经下载到本地的公共素材——生成时用 downloaded scope，不额外扣积分。" },
			{ id: "upload", label: "本地上传", hint: "先传到顾本「我的作品」，再作为生视频素材引用。" }
		];

		/** 本地上传：把文件本体当请求体 POST 过去（不走 JSON，视频有几十 MB）。 */
		async function uploadMaterialFile(file) {
			const response = await fetch(API + "/material/upload?filename=" + encodeURIComponent(file.name), {
				method: "POST",
				headers: { "content-type": file.type || "application/octet-stream" },
				body: file
			});
			const text = await response.text();
			let parsed;
			try {
				parsed = text ? JSON.parse(text) : {};
			} catch {
				parsed = { ok: false, error: text.slice(0, 200) };
			}
			if (!response.ok) throw new Error(parsed.error || `HTTP ${response.status}`);
			if (parsed.ok === false) throw new Error(parsed.error || "上传失败");
			return parsed.material;
		}

		const materialKey = (m) => `${m?.kind ?? ""}:${m?.value ?? ""}`;

		/** 素材选择器：我的作品 / 已下载的公共素材 / 本地上传。 */
		function MaterialPickerModal(props) {
			const { open, onClose, onConfirm } = props;
			const [tab, setTab] = react.useState("works");
			const [search, setSearch] = react.useState("");
			const [type, setType] = react.useState("");
			const [page, setPage] = react.useState(1);
			const [list, setList] = react.useState(null);
			const [loading, setLoading] = react.useState(false);
			const [error, setError] = react.useState("");
			const [selected, setSelected] = react.useState([]);
			const [uploadLog, setUploadLog] = react.useState([]);
			const [uploading, setUploading] = react.useState(false);

			// 换页签 / 换搜索词 / 翻页都重新拉；搜索词防抖，别每敲一个字打一次顾本
			react.useEffect(() => {
				if (!open || tab === "upload") return;
				let cancelled = false;
				setLoading(true);
				setError("");
				const timer = setTimeout(
					() => {
						const path = tab === "works" ? "/guben/works" : "/guben/materials";
						const body = tab === "works" ? { search, type, page, limit: 24 } : { search, type, page, limit: 24, onlyDownloaded: true };
						api(path, body)
							.then((res) => {
								if (!cancelled) setList(res.list ?? null);
							})
							.catch((err) => {
								if (!cancelled) setError(err instanceof Error ? err.message : String(err));
							})
							.finally(() => {
								if (!cancelled) setLoading(false);
							});
					},
					search ? 350 : 0
				);
				return () => {
					cancelled = true;
					clearTimeout(timer);
				};
			}, [open, tab, search, type, page]);

			react.useEffect(() => {
				setPage(1);
			}, [tab, search, type]);

			const isPicked = (m) => selected.some((s) => materialKey(s) === materialKey(m));
			const toggle = (m) => setSelected((prev) => (isPicked(m) ? prev.filter((s) => materialKey(s) !== materialKey(m)) : [...prev, m]));

			const pick = (item) =>
				tab === "works"
					? { kind: "work", value: item.id, title: item.title, mediaKind: item.type, thumbUrl: item.thumbUrl, previewUrl: item.previewUrl }
					: { kind: "guben", value: item.id, title: item.title, mediaKind: item.type, thumbUrl: item.thumbUrl, previewUrl: item.previewUrl };

			const doUpload = async (fileList) => {
				const files = Array.from(fileList ?? []);
				if (!files.length) return;
				setUploading(true);
				for (const file of files) {
					const label = `${file.name}（${(file.size / 1024 / 1024).toFixed(1)}MB）`;
					setUploadLog((prev) => [...prev, { label, status: "上传中…" }]);
					try {
						const material = await uploadMaterialFile(file);
						setUploadLog((prev) => prev.map((x) => (x.label === label ? { ...x, status: `已存入我的作品 #${material.value}` } : x)));
						setSelected((prev) => (prev.some((s) => materialKey(s) === materialKey(material)) ? prev : [...prev, material]));
					} catch (err) {
						setUploadLog((prev) =>
							prev.map((x) => (x.label === label ? { ...x, status: "失败：" + (err instanceof Error ? err.message : String(err)) } : x))
						);
					}
				}
				setUploading(false);
			};

			const card = (item) => {
				const picked = isPicked(pick(item));
				return h(
					"div",
					{
						key: `${item.type}-${item.id}`,
						onClick: () => toggle(pick(item)),
						style: {
							border: picked ? "2px solid var(--dsh-color-accent, #4c8dff)" : "1px solid var(--dsh-color-border, rgba(128,128,128,.3))",
							borderRadius: "9px",
							padding: "7px",
							cursor: "pointer",
							display: "flex",
							flexDirection: "column",
							gap: "5px",
							background: picked ? "rgba(76,141,255,.10)" : "transparent"
						}
					},
					item.thumbUrl
						? h("img", {
								src: item.thumbUrl,
								alt: item.title,
								loading: "lazy",
								style: { width: "100%", height: "96px", objectFit: "cover", borderRadius: "6px", background: "rgba(128,128,128,.12)" }
							})
						: h(
								"div",
								{ style: { width: "100%", height: "96px", borderRadius: "6px", background: "rgba(128,128,128,.12)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", ...T.muted } },
								"无缩略图"
							),
					h("div", { style: { fontSize: "12px", fontWeight: 600, lineHeight: 1.3, maxHeight: "32px", overflow: "hidden" } }, item.title || `#${item.id}`),
					h(
						"div",
						{ style: { ...T.row, gap: "6px", fontSize: "11px", ...T.muted } },
						h("span", { style: T.tag }, item.type === "image" ? "图片" : "视频"),
						h("span", null, `#${item.id}`),
						item.duration ? h("span", null, `${item.duration}s`) : null,
						item.width && item.height ? h("span", null, `${item.width}×${item.height}`) : null,
						h("span", { style: { flex: 1 } }),
						picked ? h("span", { style: { color: "var(--dsh-color-accent, #4c8dff)", fontWeight: 600 } }, "已选") : null
					)
				);
			};

			const items = list?.items ?? [];
			const totalPages = list ? Math.max(1, Math.ceil((list.total ?? 0) / (list.pageSize || 24))) : 1;

			return h(
				Modal,
				{ open, onClose, title: "选择生视频素材（来源：顾本素材库）" },
				h(
					"div",
					{ style: { ...T.row, gap: "6px" } },
					PICKER_TABS.map((t) =>
						h(
							"button",
							{
								key: t.id,
								type: "button",
								style: { ...T.btn, ...(tab === t.id ? { borderColor: "var(--dsh-color-accent, #4c8dff)", color: "var(--dsh-color-accent, #4c8dff)", fontWeight: 600 } : {}) },
								onClick: () => setTab(t.id)
							},
							t.label
						)
					)
				),
				h("div", { style: { fontSize: "11px", ...T.muted } }, PICKER_TABS.find((t) => t.id === tab)?.hint ?? ""),

				tab === "upload"
					? h(
							"div",
							{ style: T.sub },
							h("div", { style: { fontSize: "12px" } }, "选本地图片或视频——会先存进顾本「我的作品」，任务里记的是作品 id。"),
							h("input", {
								type: "file",
								multiple: true,
								accept: "video/*,image/*",
								disabled: uploading,
								onChange: (e) => {
									doUpload(e.target.files);
									e.target.value = "";
								}
							}),
							uploadLog.length
								? h(
										"div",
										{ style: { display: "flex", flexDirection: "column", gap: "3px", fontSize: "11px", ...T.muted } },
										uploadLog.map((x, i) => h("div", { key: i }, `${x.label} — ${x.status}`))
									)
								: null
						)
					: h(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: "9px" } },
							h(
								"div",
								{ style: { ...T.row, gap: "8px" } },
								h("input", {
									style: { ...T.input, flex: 1 },
									placeholder: "搜索标题 / 标签",
									value: search,
									onChange: (e) => setSearch(e.target.value)
								}),
								h(
									"select",
									{ style: { ...T.input, width: "110px" }, value: type, onChange: (e) => setType(e.target.value) },
									h("option", { value: "" }, "全部类型"),
									h("option", { value: "video" }, "视频"),
									h("option", { value: "image" }, "图片")
								),
								h("span", { style: { fontSize: "11px", ...T.muted } }, loading ? "读取中…" : `共 ${list?.total ?? 0} 条`)
							),
							h(Banner, { kind: "err", text: error }),
							list?.note ? h("div", { style: { fontSize: "11px", ...T.muted } }, list.note) : null,
							loading && items.length === 0
								? h("div", { style: { fontSize: "12px", ...T.muted, padding: "14px 0" } }, "正在从顾本素材库读取…")
								: items.length === 0
									? h(
											"div",
											{ style: { fontSize: "12px", ...T.muted, padding: "14px 0" } },
											tab === "materials"
												? "没有已下载的公共素材。可以先用顾本 skill 把素材下载到本地（download），或改用「我的作品 / 本地上传」。"
												: "没有匹配的素材。"
										)
									: h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(132px,1fr))", gap: "9px" } }, items.map(card)),
							h(
								"div",
								{ style: { ...T.row, gap: "8px" } },
								h(Btn, { disabled: loading || page <= 1, onClick: () => setPage((p) => Math.max(1, p - 1)) }, "上一页"),
								h("span", { style: { fontSize: "11px", ...T.muted } }, `第 ${list?.page ?? page} / ${totalPages} 页`),
								h(Btn, { disabled: loading || page >= totalPages, onClick: () => setPage((p) => p + 1) }, "下一页")
							)
						),

				selected.length
					? h(
							"div",
							{ style: T.sub },
							h("div", { style: { fontSize: "12px" } }, `已选 ${selected.length} 条`),
							selected.map((m, i) =>
								h(
									"div",
									{ key: i, style: { ...T.row, gap: "7px", fontSize: "11px" } },
									h("span", { style: T.tag }, m.kind === "work" ? "我的作品" : "公共素材"),
									h("span", { style: { wordBreak: "break-all" } }, `${m.title || "(无标题)"} #${m.value}`),
									h("span", { style: { flex: 1 } }),
									h("span", { style: { cursor: "pointer", ...T.muted }, onClick: () => setSelected((prev) => prev.filter((_, j) => j !== i)) }, "移除")
								)
							)
						)
					: null,

				h(
					"div",
					{ style: { ...T.row, justifyContent: "flex-end" } },
					h(Btn, { disabled: uploading, onClick: onClose }, "取消"),
					h(
						Btn,
						{
							primary: true,
							disabled: uploading || selected.length === 0,
							onClick: () => {
								onConfirm(selected);
								setSelected([]);
								setUploadLog([]);
								onClose();
							}
						},
						`加入任务（${selected.length}）`
					)
				)
			);
		}

		/** 新建任务弹窗：题目给的是选题，不是提示词。 */
		function NewTaskModal(props) {
			const { state, run, busy, open, onClose } = props;
			const empty = { topic: "", refsText: "", duration: 15, aspect: "portrait", caption: "", accountId: "", market: "us-eu", useRefs: false };
			const [form, setForm] = react.useState(empty);
			const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
			const accountId = form.accountId || state.accounts[0]?.id || "";

			const submit = async (asDraft) => {
				await run(asDraft ? "存草稿" : "提交任务", () =>
					api("/task/create", {
						task: {
							topic: form.topic,
							refs: parseRefs(form.refsText),
							duration: Number(form.duration) || 15,
							aspect: form.aspect,
							caption: form.caption,
							accountId,
							market: form.market,
							useRefsForGeneration: form.useRefs,
							submit: !asDraft
						}
					})
				);
				setForm(empty);
				onClose();
			};

			return h(
				Modal,
				{ open, onClose, title: "新建任务" },
				h("div", { style: { fontSize: "12px", ...T.muted } }, "你给的是选题方向，不是提示词——提示词由 agent 按选题和参考素材来写。"),
				// 选题常常是一段完整的故事/场景描述，单行输入框写不下，用多行
				h(Field, { label: "选题（创作方向）" },
					h("textarea", {
						style: { ...T.input, minHeight: "96px", resize: "vertical", lineHeight: 1.5 },
						value: form.topic,
						placeholder: "把创作方向写清楚，例如：\n一个欧美男子想给妻子定制钻戒但不知道去哪定制，他在 Google 搜索找到 YFN 网站提交了定制订单，很快收到礼物，妻子收到戒指非常开心",
						onChange: set("topic")
					})
				),
				h(Field, { label: "参考素材（每行一个：图片/视频/网页链接，或顾本素材 id）" },
					h("textarea", {
						style: { ...T.input, minHeight: "70px", resize: "vertical" },
						value: form.refsText,
						placeholder: "https://example.com/ref.jpg\n2506\nhttps://example.com/page",
						onChange: set("refsText")
					})
				),
				h(
					"div",
					{ style: T.grid },
					h(Field, { label: "视频时长（秒）" }, h("input", { style: T.input, value: form.duration, onChange: set("duration") })),
					h(Field, { label: "视频比例" },
						h("select", { style: T.input, value: form.aspect, onChange: set("aspect") },
							h("option", { value: "portrait" }, "竖屏 9:16"),
							h("option", { value: "landscape" }, "横屏 16:9"),
							h("option", { value: "square" }, "方形 1:1")
						)
					),
					h(Field, { label: "TikTok 账号" },
						h("select", { style: T.input, value: accountId, onChange: set("accountId") },
							state.accounts.length === 0 ? h("option", { value: "" }, "（先去「设置」添加）") : null,
							state.accounts.map((a) => h("option", { key: a.id, value: a.id }, a.label || a.username))
						)
					),
					h(Field, { label: "目标市场" },
						h("select", { style: T.input, value: form.market, onChange: set("market") },
							h("option", { value: "us-eu" }, "欧美市场（默认，英语）"),
							h("option", { value: "cn" }, "国内市场（中文）"),
							h("option", { value: "other" }, "其它（按描述）")
						)
					)
				),
				h(
					"label",
					{ style: { ...T.row, gap: "7px", fontSize: "12px", cursor: "pointer" } },
					h("input", {
						type: "checkbox",
						checked: form.useRefs,
						onChange: (e) => setForm({ ...form, useRefs: e.target.checked })
					}),
					"用这些参考素材直接生成视频",
					h("span", { style: { ...T.muted } }, "（默认不勾：参考素材只用来写提示词，不传给模型）")
				),
				h(Field, { label: "发布文案（可留空，发布时用选题兜底）" },
					h("input", { style: T.input, value: form.caption, onChange: set("caption") })
				),
				h(
					"div",
					{ style: { ...T.row, justifyContent: "flex-end" } },
					h(Btn, { disabled: busy, onClick: onClose }, "取消"),
					h(Btn, { disabled: busy || !form.topic.trim(), onClick: () => submit(true) }, "只存草稿"),
					h(Btn, { primary: true, disabled: busy || !form.topic.trim(), onClick: () => submit(false) }, "提交任务")
				)
			);
		}

		/** 看板列：状态 + 颜色。 */
		const BOARD_COLUMNS = [
			{ key: "draft", color: "#8b8b8b" },
			{ key: "working", color: "#4c8dff" },
			{ key: "script_review", color: "#d9a441" },
			{ key: "video_review", color: "#c471ed" },
			{ key: "ready", color: "#30a46c" },
			{ key: "published", color: "#2bb3a3" }
		];

		/**
		 * 能就地改的字段。
		 *
		 * 「进行中」是过程状态——那期间改了参数，正在跑的那一步就不知道按哪版算，
		 * 所以一律只读；要改先去「取消当前操作」退回来源状态。
		 * 提示词单独判：只有「进行中·生成提示词」时才是 agent 交作业，其余进行中也不可写。
		 */
		const META_EDIT_STATUS = ["script_review", "video_review"];
		const canEditPromptNow = (task) =>
			task.status === "script_review" || (task.status === "working" && task.op?.kind === "prompt");

		/** 「进行中」在界面上要说清楚在跑哪一步，否则用户只看到一个不能点的任务。 */
		const OP_LABEL_FALLBACK = { prompt: "生成提示词", video: "生成视频", publish: "发布" };
		const opLabel = (task, state) =>
			task?.op ? (state?.opLabels?.[task.op.kind] ?? OP_LABEL_FALLBACK[task.op.kind] ?? task.op.kind) : "";
		const statusText = (task, state) => {
			const base = state?.statusLabels?.[task.status] ?? task.status;
			return task?.status === "working" && task.op ? `${base} · ${opLabel(task, state)}` : base;
		};

		/** 详情弹窗：把任务的全部字段摊开，对应需求里列的那一组信息。 */
		function TaskDetailModal(props) {
			const { task, state, run, busy, open, onClose } = props;
			// hooks 必须在任何 return 之前：弹窗是常驻的同一个组件实例，
			// task 从 null 变成有值时如果 hook 数量跟着变，React 会直接报错。
			const [note, setNote] = react.useState("");
			const [promptDraft, setPromptDraft] = react.useState(task?.prompt ?? "");
			const [durationDraft, setDurationDraft] = react.useState(String(task?.duration ?? ""));
			const [optimizeHint, setOptimizeHint] = react.useState("");
			const [pickerOpen, setPickerOpen] = react.useState(false);
			const [providerDraft, setProviderDraft] = react.useState(task?.provider ?? "guben");
			const taskId = task?.id ?? null;
			const serverPrompt = task?.prompt ?? "";
			const serverDuration = task?.duration;
			const serverProvider = task?.provider ?? "guben";
			// 服务端的值变了（切任务、agent 优化回填、时长保存成功）就把草稿同步过来
			react.useEffect(() => {
				setPromptDraft(serverPrompt);
			}, [taskId, serverPrompt]);
			react.useEffect(() => {
				setDurationDraft(String(serverDuration ?? ""));
			}, [taskId, serverDuration]);
			react.useEffect(() => {
				setProviderDraft(serverProvider);
			}, [taskId, serverProvider]);

			if (!task) return h(Modal, { open: false, onClose });
			const canEditPrompt = canEditPromptNow(task);
			const canEditMeta = META_EDIT_STATUS.includes(task.status);
			const locked = task.status === "working";
			const act = (label, fn) => () => run(label, fn);
			const transition = (to, label) => act(label, () => api("/task/transition", { id: task.id, to }));
			// 脚本「通过」= 授权生成视频，所以通道要一起带过去（生成是在这一步开跑的）
			const review = (stage, decision) =>
				act(decision === "approve" ? "审核通过" : "驳回", () =>
					api("/task/review", {
						id: task.id,
						stage,
						decision,
						note,
						...(stage === "script" ? { provider: providerDraft } : {})
					})
				);

			// 保存提示词与时长：都在脚本审核阶段就地改，不跳状态
			const savePrompt = act("保存提示词", () => api("/task/prompt", { id: task.id, prompt: promptDraft }));
			const saveDuration = act("保存时长", () => api("/task/update", { id: task.id, patch: { duration: Number(durationDraft) || task.duration } }));
			const optimizePrompt = act("让 agent 优化提示词", () => api("/task/optimize-prompt", { id: task.id, hint: optimizeHint }));
			const addMaterials = (picked) =>
				act("加入生视频素材", () =>
					api("/task/materials", {
						id: task.id,
						genMaterials: [
							...(task.genMaterials ?? []),
							...picked.filter((m) => !(task.genMaterials ?? []).some((x) => x.kind === m.kind && String(x.value) === String(m.value)))
						]
					})
				)();
			const removeMaterial = (index) =>
				act("移除生视频素材", () =>
					api("/task/materials", { id: task.id, genMaterials: (task.genMaterials ?? []).filter((_, i) => i !== index) })
				)();

			const fmt = (v) => (v ? String(v).slice(0, 19).replace("T", " ") : "—");

			const actions = [];
			if (task.status === "draft") actions.push(h(Btn, { key: "s", primary: true, disabled: busy, onClick: transition("working", "提交任务") }, "提交"));
			// 进行中是过程状态：不再提供「生成视频」，只给「取消」当逃生口。
			// 生成已改成由脚本审核通过触发，所以这里没有别的动作可给。
			if (task.status === "working" && task.op?.kind === "prompt" && !task.prompt)
				actions.push(h(Btn, { key: "d", primary: true, disabled: busy, onClick: act("让 agent 处理", () => api("/task/dispatch", { id: task.id })) }, "让 agent 处理"));
			if (task.status === "working")
				actions.push(
					h(
						Btn,
						{
							key: "c",
							disabled: busy,
							onClick: act("取消当前操作", () => api("/task/cancel", { id: task.id, reason: "人工取消" }))
						},
						`取消当前操作（${opLabel(task, state)}）`
					)
				);
			if (task.status === "script_review") {
				actions.push(
					// 生成通道在这里选：顾本吃素材 id，MiniMax 吃文本 + 参考图字节，
					// 两条路的素材语义不同，所以做成任务级选择而不是全局开关。
					h(
						"span",
						{ key: "pv", style: { display: "inline-flex", alignItems: "center", gap: "5px" } },
						h("span", { style: { fontSize: "12px", ...T.muted } }, "生视频通道"),
						h(
							"select",
							{
								style: { ...T.input, width: "auto", padding: "4px 6px" },
								value: providerDraft,
								onChange: (e) => setProviderDraft(e.target.value)
							},
							PROVIDER_OPTIONS.map((o) => h("option", { key: o.key, value: o.key }, o.label))
						)
					),
					// 通过 = 授权生成，会直接开跑（进行中·生成视频）；失败会退回脚本审核
					h(Btn, { key: "a", primary: true, disabled: busy, onClick: review("script", "approve") }, "脚本通过并生成视频"),
					h(Btn, { key: "r", disabled: busy, onClick: review("script", "reject") }, "驳回")
				);
			}
			if (task.status === "video_review") {
				actions.push(h(Btn, { key: "a", primary: true, disabled: busy, onClick: review("video", "approve") }, "审片通过"));
				actions.push(h(Btn, { key: "r", disabled: busy, onClick: review("video", "reject") }, "驳回（退回脚本审核）"));
			}
			if (task.status === "ready")
				actions.push(h(Btn, { key: "p", primary: true, disabled: busy, onClick: act("发布到 TikTok", () => api("/task/publish", { id: task.id })) }, "发布到 TikTok"));

			return h(
				Modal,
				{ open, onClose, title: "任务详情" },
				h(
					"div",
					{ style: T.row },
					h("span", { style: { ...T.tag, ...(STATUS_STYLE[task.status] ?? {}) } }, statusText(task, state)),
					h("span", { style: { fontSize: "12px", ...T.muted } }, task.id)
				),
				h(Row, { label: "选题" }, h("strong", null, task.topic)),
				h(
					Row,
					{ label: "参考素材" },
					task.refs && task.refs.length
						? h(
								"div",
								{ style: { display: "flex", flexDirection: "column", gap: "6px" } },
								h("div", { style: { fontSize: "11px", ...T.muted } }, "给 agent 写提示词用，默认不传给生成模型"),
								task.refs.map((r, i) => h(MaterialRow, { key: i, item: r }))
							)
						: "—"
				),
				h(
					Row,
					{ label: "视频时长" },
					canEditMeta
						? h(
								"div",
								{ style: { display: "flex", flexDirection: "column", gap: "5px" } },
								h(
									"div",
									{ style: { ...T.row, gap: "7px" } },
									h("input", {
										style: { ...T.input, width: "88px" },
										value: durationDraft,
										onChange: (e) => setDurationDraft(e.target.value)
									}),
									h("span", { style: { fontSize: "12px", ...T.muted } }, "秒"),
									h(
										Btn,
										{
											disabled: busy || String(task.duration) === String(Number(durationDraft) || task.duration),
											onClick: saveDuration
										},
										"保存时长"
									)
								),
								h("div", { style: { fontSize: "11px", ...T.muted } }, "生成视频时按这个时长提交；改完再点「生成视频」。")
							)
						: `${task.duration} 秒`
				),
				h(Row, { label: "视频比例" }, ASPECT_LABEL[task.aspect] ?? task.aspect),
				h(
					Row,
					{ label: "生视频通道" },
					(state.providerLabels?.[task.provider ?? "guben"] ?? "顾本素材库") +
						(task.provider === "minimax"
							? `　${state.settings.minimaxModel ?? "MiniMax-H3"} / ${state.settings.minimaxResolution ?? "768P"}` +
								(state.settings.minimaxToken ? "" : "（⚠️ 还没配 MiniMax Token）")
							: "")
				),
				h(
					Row,
					{ label: "目标市场" },
					(state.marketLabels?.[task.market] ?? task.market ?? "欧美市场") +
						(task.market === "cn" ? "（中文）" : task.market === "other" ? "" : "（英语）")
				),
				h(
					Row,
					{ label: "生成提示词" },
					canEditPrompt
						? h(
								"div",
								{ style: { display: "flex", flexDirection: "column", gap: "7px" } },
								h("textarea", {
									style: { ...T.input, minHeight: "180px", resize: "vertical", lineHeight: 1.5, fontSize: "12px" },
									value: promptDraft,
									placeholder: "可以在这里直接改提示词，或让 agent 按 sd25-pe 官方规范重写一版。",
									onChange: (e) => setPromptDraft(e.target.value)
								}),
								h(
									"div",
									{ style: { ...T.row, gap: "7px" } },
									h(Btn, { primary: true, disabled: busy || !promptDraft.trim() || promptDraft === (task.prompt ?? "") || !canEditPrompt, onClick: savePrompt }, "保存提示词"),
									h(Btn, { disabled: busy || !promptDraft.trim(), onClick: () => setPromptDraft(task.prompt ?? "") }, "还原"),
									h("span", { style: { fontSize: "11px", ...T.muted } }, `${promptDraft.length} 字`)
								),
								h(
									"div",
									{ style: { ...T.row, gap: "7px" } },
									h("input", {
										style: { ...T.input, flex: 1 },
										placeholder: "可选：给 agent 的优化要求，例如「开头三秒先给钻戒微距」「不要出现对白」",
										value: optimizeHint,
										onChange: (e) => setOptimizeHint(e.target.value)
									}),
									h(Btn, { disabled: busy, onClick: optimizePrompt }, "让 agent 优化提示词")
								),
								h(
									"div",
									{ style: { fontSize: "11px", ...T.muted } },
									"「让 agent 优化」会新开一个会话，加载 sd25-pe skill 重写提示词后回写这条任务（状态仍停在脚本审核）。跑完点右上角「刷新」看结果。"
								),
								task.promptHistory && task.promptHistory.length
									? h(
											"details",
											null,
											h("summary", { style: { fontSize: "11px", cursor: "pointer", ...T.muted } }, `历史版本（${task.promptHistory.length}）`),
											h(
												"div",
												{ style: { display: "flex", flexDirection: "column", gap: "6px", marginTop: "6px" } },
												task.promptHistory.map((h0, i) =>
													h(
														"div",
														{ key: i, style: T.sub },
														h(
															"div",
															{ style: { ...T.row, gap: "7px", fontSize: "11px" } },
															h("span", { style: T.tag }, fmt(h0.at)),
															h("span", { style: { flex: 1 } }),
															h("span", { style: { cursor: "pointer", ...T.muted }, onClick: () => setPromptDraft(h0.prompt) }, "回填到编辑框")
														),
														h("div", { style: { fontSize: "11px", ...T.muted, whiteSpace: "pre-wrap", maxHeight: "120px", overflow: "auto" } }, h0.prompt)
													)
												)
											)
										)
									: null
							)
						: task.prompt
							? h("div", { style: { whiteSpace: "pre-wrap" } }, task.prompt)
							: "—"
				),
				h(
					Row,
					{ label: "生视频素材" },
					h(
						"div",
						{ style: { display: "flex", flexDirection: "column", gap: "6px" } },
						h(
							"div",
							{ style: { fontSize: "11px", ...T.muted } },
							"这些才是真正传给生成模型、会影响画面的素材（参考素材不传）。来源：顾本「我的作品」或已下载的公共素材；本地上传会先存进「我的作品」。"
						),
						task.genMaterials && task.genMaterials.length
							? task.genMaterials.map((m, i) => h(MaterialRow, { key: i, item: m, onRemove: canEditMeta ? () => removeMaterial(i) : undefined }))
							: h("span", { style: { fontSize: "12px", ...T.muted } }, "未指定（仅凭提示词生成）"),
						canEditMeta
							? h(
									"div",
									{ style: T.row },
									h(Btn, { disabled: busy, onClick: () => setPickerOpen(true) }, "从顾本素材库添加…")
								)
							: null
					)
				),
				task.materialNotes && task.materialNotes.length
					? h(Row, { label: "素材处理" }, h("div", { style: { fontSize: "11px", ...T.muted, whiteSpace: "pre-wrap" } }, task.materialNotes.join("\n")))
					: null,
				h(
					Row,
					{ label: "生成产物" },
					task.outputs && task.outputs.length
						? h(
								"div",
								{ style: { display: "flex", flexDirection: "column", gap: "6px" } },
								task.outputs.map((o, i) => h(MaterialRow, { key: i, size: "full", item: { kind: o.kind ?? "video", value: o.path ?? o.value } }))
							)
						: "—"
				),
				h(
					Row,
					{ label: "时间" },
					h(
						"div",
						{ style: { display: "flex", flexDirection: "column", gap: "3px", fontSize: "12px" } },
						h("span", null, "提交　" + fmt(task.submittedAt)),
						h("span", null, "脚本审核　" + fmt(task.scriptApprovedAt)),
						h("span", null, "审片　" + fmt(task.videoApprovedAt)),
						h("span", null, "发布　" + fmt(task.publishedAt))
					)
				),
				task.scriptReview || task.videoReview
					? h(
							Row,
							{ label: "审核意见" },
							h(
								"div",
								{ style: { display: "flex", flexDirection: "column", gap: "3px", fontSize: "12px" } },
								task.scriptReview ? h("span", null, `脚本：${task.scriptReview.decision === "approve" ? "通过" : "驳回"}${task.scriptReview.note ? "（" + task.scriptReview.note + "）" : ""}`) : null,
								task.videoReview ? h("span", null, `审片：${task.videoReview.decision === "approve" ? "通过" : "驳回"}${task.videoReview.note ? "（" + task.videoReview.note + "）" : ""}`) : null
							)
						)
					: null,
				h(
					Row,
					{ label: "反馈数据" },
					task.metrics
						? h(
								"div",
								{ style: { ...T.row, gap: "16px" } },
								h("span", null, `观看次数 ${task.metrics.views ?? "—"}`),
								h("span", null, `点赞数 ${task.metrics.likes ?? "—"}`),
								h("span", null, `评论数 ${task.metrics.comments ?? "—"}`),
								h("span", null, `分享次数 ${task.metrics.shares ?? "—"}`)
							)
						: h("span", { style: { ...T.muted, fontSize: "12px" } }, "尚未采集（发布后在「视频数据」页签点采集）")
				),
				task.dispatchedSessionId ? h(Row, { label: "处理会话" }, h("span", { style: { fontSize: "12px", ...T.muted } }, task.dispatchedSessionId)) : null,
				task.url ? h(Row, { label: "作品链接" }, h("a", { href: task.url, target: "_blank", rel: "noreferrer" }, task.url)) : null,
				task.status === "script_review" || task.status === "video_review"
					? h("input", { style: T.input, placeholder: "审核意见（驳回时建议填写）", value: note, onChange: (e) => setNote(e.target.value) })
					: null,
				actions.length ? h("div", { style: { ...T.row, gap: "8px" } }, actions) : null,
				h("div", { style: T.label }, "流转记录"),
				h("pre", { style: T.pre }, (task.log ?? []).map((l) => `${fmt(l.at)}  ${l.text}`).join("\n") || "（无）"),
				h(MaterialPickerModal, {
					open: pickerOpen,
					onClose: () => setPickerOpen(false),
					onConfirm: (picked) => {
						if (picked.length) addMaterials(picked);
					}
				})
			);
		}

		/** 看板卡片：尽量紧凑，动作按状态给。 */
		function TaskCard(props) {
			const { task, state, run, busy, onOpen } = props;
			const [note, setNote] = react.useState("");
			// 卡片整体可点开详情；内部按钮/输入框/链接要阻止冒泡，否则会连带打开弹窗
			const stop = (node) => h("span", { onClick: (e) => e.stopPropagation(), style: { display: "contents" } }, node);
			const status = task.status;
			const act = (label, fn) => () => run(label, fn);
			const transition = (to, label) => act(label, () => api("/task/transition", { id: task.id, to }));
			// 脚本「通过」= 授权生成视频，所以通道要一起带过去（生成是在这一步开跑的）
			const review = (stage, decision) =>
				act(decision === "approve" ? "审核通过" : "驳回", () =>
					api("/task/review", {
						id: task.id,
						stage,
						decision,
						note,
						...(stage === "script" ? { provider: providerDraft } : {})
					})
				);

			const actions = [];
			if (status === "draft") actions.push(h(Btn, { key: "s", primary: true, disabled: busy, onClick: transition("working", "提交任务") }, "提交"));
			if (status === "working") {
				if (task.op?.kind === "prompt" && !task.prompt) {
					// 提交时会自动派活；万一没派上（网关不可用等），这里能手动再来一次
					actions.push(h(Btn, { key: "d", primary: true, disabled: busy, onClick: act("让 agent 处理", () => api("/task/dispatch", { id: task.id })) }, "让 agent 处理"));
					actions.push(h("span", { key: "w", style: { fontSize: "11px", ...T.muted } }, task.dispatchedSessionId ? "已派给 agent，等它写提示词" : "等 agent 写提示词"));
				} else {
					actions.push(h("span", { key: "w", style: { fontSize: "11px", ...T.muted } }, `正在${opLabel(task, state)}…`));
				}
				// 进行中不能改也不能删，所以必须留这个逃生口，否则卡死就是死局
				actions.push(h(Btn, { key: "c", disabled: busy, onClick: act("取消当前操作", () => api("/task/cancel", { id: task.id, reason: "人工取消" })) }, "取消"));
			}
			if (status === "script_review") {
				actions.push(h(Btn, { key: "a", primary: true, disabled: busy, onClick: review("script", "approve") }, "通过并生成"));
				actions.push(h(Btn, { key: "r", disabled: busy, onClick: review("script", "reject") }, "驳回"));
			}
			if (status === "video_review") {
				actions.push(h(Btn, { key: "a", primary: true, disabled: busy, onClick: review("video", "approve") }, "审片通过"));
				actions.push(h(Btn, { key: "r", disabled: busy, onClick: review("video", "reject") }, "驳回"));
			}
			if (status === "ready") actions.push(h(Btn, { key: "p", primary: true, disabled: busy, onClick: act("发布到 TikTok", () => api("/task/publish", { id: task.id })) }, "发布"));

			return h(
				"div",
				{
					onClick: () => onOpen && onOpen(task),
					title: "点击查看任务详情",
					style: {
						border: "1px solid var(--dsh-color-border, rgba(128,128,128,.22))",
						borderRadius: "9px",
						padding: "10px",
						display: "flex",
						flexDirection: "column",
						gap: "6px",
						background: "var(--dsh-color-surface, rgba(128,128,128,.05))",
						cursor: "pointer"
					}
				},
				h("div", { style: { fontSize: "13px", fontWeight: 600, lineHeight: 1.35 } }, task.topic),
				h(
					"div",
					{ style: { fontSize: "11px", ...T.muted } },
					`${task.duration}s · ${ASPECT_LABEL[task.aspect] ?? task.aspect}` +
						(task.refs && task.refs.length ? ` · 参考 ${task.refs.length} 条` : "") +
						// 默认欧美不标，免得每张卡都重复；非默认才提示
						(task.market && task.market !== "us-eu" ? ` · ${state.marketLabels?.[task.market] ?? task.market}` : "")
				),
				task.prompt ? h("div", { style: { fontSize: "11px", ...T.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "提示词 " + task.prompt) : null,
				task.metrics
					? h(
							"div",
							{ style: { fontSize: "11px", ...T.row, gap: "8px" } },
							h("span", null, `看 ${task.metrics.views ?? "-"}`),
							h("span", null, `赞 ${task.metrics.likes ?? "-"}`),
							h("span", null, `评 ${task.metrics.comments ?? "-"}`),
							h("span", null, `转 ${task.metrics.shares ?? "-"}`)
						)
					: null,
				status === "script_review" || status === "video_review"
					? stop(h("input", { style: { ...T.input, fontSize: "12px", padding: "5px 8px" }, placeholder: "审核意见（驳回时建议填）", value: note, onChange: (e) => setNote(e.target.value) }))
					: null,
				actions.length ? stop(h("div", { style: { ...T.row, gap: "6px" } }, actions)) : null,
				stop(
					h(
						"div",
						{ style: { ...T.row, gap: "8px", fontSize: "11px" } },
						task.url ? h("a", { href: task.url, target: "_blank", rel: "noreferrer" }, "打开作品") : null,
						h("span", { style: { flex: 1 } }),
						// 进行中不给删除入口：那一步操作还在跑，删掉它就没了落点
						status === "working"
							? h("span", { style: { ...T.muted }, title: "进行中不能删除，请先取消当前操作" }, "删除")
							: h("span", { style: { cursor: "pointer", ...T.muted }, onClick: act("删除任务", () => api("/task/delete", { id: task.id })) }, "删除")
					)
				),
			);
		}

		/** 运营任务：看板式排版，按状态分列。 */
		function TasksTab(props) {
			const { state, run, busy } = props;
			const [detailId, setDetailId] = react.useState(null);
			const detail = detailId ? state.tasks.find((t) => t.id === detailId) ?? null : null;
			const byStatus = {};
			for (const s of BOARD_COLUMNS) byStatus[s.key] = [];
			for (const t of state.tasks) (byStatus[t.status] ?? (byStatus[t.status] = [])).push(t);

			return h(
				"div",
				{ style: { flex: 1, minHeight: 0, display: "flex", gap: "10px", overflowX: "auto", overflowY: "hidden", paddingBottom: "4px" } },
				BOARD_COLUMNS.map((col) =>
					h(
						"div",
						{
							key: col.key,
							style: {
								flex: "1 0 232px",
								minWidth: "232px",
								display: "flex",
								flexDirection: "column",
								gap: "8px",
								background: "rgba(128,128,128,.06)",
								border: "1px solid var(--dsh-color-border, rgba(128,128,128,.18))",
								borderRadius: "10px",
								padding: "10px",
								overflowY: "auto",
								minHeight: 0
							}
						},
						h(
							"div",
							{ style: { ...T.row, gap: "7px", position: "sticky", top: 0 } },
							h("span", { style: { width: "8px", height: "8px", borderRadius: "50%", background: col.color, flex: "0 0 auto" } }),
							h("strong", { style: { fontSize: "13px" } }, state.statusLabels?.[col.key] ?? col.key),
							h("span", { style: { flex: 1 } }),
							h("span", { style: { fontSize: "11px", ...T.muted } }, String((byStatus[col.key] ?? []).length))
						),
						(byStatus[col.key] ?? []).length === 0
							? h("div", { style: { fontSize: "11px", ...T.muted, textAlign: "center", padding: "18px 0" } }, "这个状态还没有任务")
							: (byStatus[col.key] ?? []).map((t) => h(TaskCard, { key: t.id, task: t, state, run, busy, onOpen: (x) => setDetailId(x.id) }))
					)
				),
				h(TaskDetailModal, { task: detail, state, run, busy, open: Boolean(detail), onClose: () => setDetailId(null) })
			);
		}


		function DataTab(props) {
			const { state, run, busy } = props;
			const published = state.tasks.filter((t) => t.status === "published");
			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: "14px" } },
				h(
					"div",
					{ style: T.row },
					h(Btn, { primary: true, disabled: busy || state.accounts.length === 0, onClick: () => run("采集数据与评论", () => api("/collect", {})) }, "立即采集"),
					h("span", { style: { fontSize: "12px", ...T.muted } }, "采集观看/点赞/评论/分享，并抓取评论。定时采集见「洞察」页签说明。")
				),
				h(
					"div",
					{ style: T.card },
					h("div", { style: { fontWeight: 600 } }, `已发布（${published.length}）`),
					published.length === 0
						? h("div", { style: { fontSize: "13px", ...T.muted } }, "还没有发布完成的视频。")
						: published.map((t) =>
								h(
									"div",
									{ key: t.id, style: T.sub },
									h(TaskRowHeader, { task: t, state }),
									t.metrics
										? h(
												"div",
												{ style: { ...T.row, gap: "16px", fontSize: "13px" } },
												h("span", null, `观看 ${t.metrics.views ?? "-"}`),
												h("span", null, `点赞 ${t.metrics.likes ?? "-"}`),
												h("span", null, `评论 ${t.metrics.comments ?? "-"}`),
												h("span", null, `分享 ${t.metrics.shares ?? "-"}`)
											)
										: h("div", { style: { fontSize: "12px", ...T.muted } }, "尚未采集到数据"),
									h("div", { style: { fontSize: "11px", ...T.muted } }, `更新于 ${t.metricsUpdatedAt ? String(t.metricsUpdatedAt).slice(0, 19).replace("T", " ") : "未采集"}`)
								)
							)
				)
			);
		}

		function TaskRowHeader(props) {
			const { task, state } = props;
			return h(
				"div",
				{ style: T.row },
				h("span", { style: { ...T.tag, ...(STATUS_STYLE[task.status] ?? {}) } }, statusText(task, state)),
				h("strong", { style: { fontSize: "13px" } }, task.topic),
				task.url ? h("a", { href: task.url, target: "_blank", rel: "noreferrer", style: { fontSize: "12px" } }, "打开作品") : null
			);
		}

		function CommentsTab(props) {
			const { state, run, busy } = props;
			const rows = state.commentsRows ?? [];
			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: "14px" } },
				h(
					"div",
					{ style: T.row },
					h(Btn, { primary: true, disabled: busy || state.accounts.length === 0, onClick: () => run("采集评论", () => api("/collect", {})) }, "立即采集"),
					h("span", { style: { fontSize: "12px", ...T.muted } }, `最近采集：${state.commentsUpdatedAt ? String(state.commentsUpdatedAt).slice(0, 19).replace("T", " ") : "未采集"}`)
				),
				state.commentsScreenshot
					? h("div", { style: { fontSize: "12px", ...T.muted } }, `现场截图：${state.commentsScreenshot}`)
					: null,
				h(
					"div",
					{ style: T.card },
					h("div", { style: { fontWeight: 600 } }, `评论（${rows.length}）`),
					rows.length === 0
						? h("div", { style: { fontSize: "13px", ...T.muted } }, "还没有采集到评论。")
						: rows.map((row, i) =>
								h("div", { key: i, style: { ...T.sub, fontSize: "13px" } }, row)
							),
					state.commentsRaw ? h("pre", { style: T.pre }, state.commentsRaw) : null
				)
			);
		}

		function InsightsTab(props) {
			const { state, run, busy } = props;
			const ins = state.insights;
			const card = (title, children) => h("div", { style: T.card }, h("div", { style: { fontWeight: 600 } }, title), children);
			const table = (rows) =>
				rows.length === 0
					? h("div", { style: { fontSize: "12px", ...T.muted } }, "暂无数据")
					: rows.map((r) =>
							h(
								"div",
								{ key: r.key, style: { ...T.row, fontSize: "13px" } },
								h("span", { style: { minWidth: "80px" } }, r.label),
								h("span", null, `${r.count} 条`),
								h("span", null, `平均播放 ${r.avgViews}`),
								h("span", { style: T.muted }, `赞 ${r.likes} · 评 ${r.comments} · 转 ${r.shares}`)
							)
						);
			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: "14px" } },
				h(
					"div",
					{ style: T.row },
					h(Btn, { primary: true, disabled: busy, onClick: () => run("重算洞察", () => api("/insights", {})) }, "重算"),
					h("span", { style: { fontSize: "12px", ...T.muted } }, `生成于 ${ins?.generatedAt ? String(ins.generatedAt).slice(0, 19).replace("T", " ") : "尚未生成"}`)
				),
				h(
					"div",
					{ style: T.card },
					h("div", { style: { fontWeight: 600 } }, "自动化：在 DSH 任务看板建两条重复任务"),
					h("div", { style: { fontSize: "12px", ...T.muted } },
						"任务看板的 cron 会定时唤起一个 agent 会话；把下面两段提示词各建一条任务即可。"
					),
					h("div", { style: { fontSize: "12px", fontWeight: 600, marginTop: "4px" } }, "① 处理任务队列（让「进行中」动起来）"),
					h("pre", { style: T.pre }, "处理 TikTok 运营助手的任务队列：用 tiktok_ops_tasks 找出「进行中」的任务，针对每条任务的选题和参考素材，用 tiktok_ops_set_prompt 写出生成视频的提示词，推到脚本审核。"),
					h("div", { style: { fontSize: "12px", ...T.muted } }, "建议 cron：0 */2 * * *（每 2 小时一次）"),
					h("div", { style: { fontSize: "12px", fontWeight: 600, marginTop: "6px" } }, "② 数据巡检（回采数据与评论）"),
					h("pre", { style: T.pre }, "执行 TikTok 运营助手的数据巡检：调用 tiktok_ops_collect 采集观看/点赞/评论/分享与评论内容，再用 tiktok_ops_insights 看运营洞察，并给出下一轮选题建议。"),
					h("div", { style: { fontSize: "12px", ...T.muted } }, "建议 cron：0 */6 * * *（每 6 小时一次）")
				),
				ins
					? h(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: "14px" } },
							card(
								"整体表现",
								h(
									"div",
									{ style: { ...T.row, gap: "16px", fontSize: "13px" } },
									h("span", null, `作品 ${ins.totals.count}`),
									h("span", null, `观看 ${ins.totals.views}`),
									h("span", null, `点赞 ${ins.totals.likes}`),
									h("span", null, `评论 ${ins.totals.comments}`),
									h("span", null, `分享 ${ins.totals.shares}`),
									h("span", { style: T.muted }, ins.engagementRate === null ? "互动率 -" : `互动率 ${(ins.engagementRate * 100).toFixed(2)}%`)
								)
							),
							!ins.sharesAvailable
								? h("div", { style: { fontSize: "12px", ...T.muted } },
										"提示：「分享」列在创作中心默认不显示，所以在内容页开启分享列之前该项恒为 0。")
								: null,
							card("按画面比例", table(ins.byAspect)),
							card("按时长", table(ins.byDuration)),
							card(
								"播放前 5",
								ins.top.length === 0
									? h("div", { style: { fontSize: "12px", ...T.muted } }, "暂无数据")
									: ins.top.map((t) =>
											h(
												"div",
												{ key: t.id, style: { ...T.row, fontSize: "13px" } },
												h("span", null, `观看 ${t.views ?? "-"}`),
												h("strong", null, t.topic),
												h("span", { style: T.muted }, `${t.duration}s · ${ASPECT_LABEL[t.aspect] ?? t.aspect}`)
											)
										)
							),
							h("div", { style: { fontSize: "12px", ...T.muted } },
								"「下一条拍什么」不在这里自动下结论——让 agent 读这份洞察去推理，它能看到完整的选题与提示词上下文。"
							)
						)
					: h("div", { style: { fontSize: "13px", ...T.muted } }, "还没有洞察数据。先发布视频并采集一次数据。")
			);
		}

		// ------------------------------------------------------------ 设置

		function SettingsTab(props) {
			const { state, run, busy } = props;
			const [account, setAccount] = react.useState({ label: "", username: "", password: "" });
			const [token, setToken] = react.useState("");
			const [mmToken, setMmToken] = react.useState("");
			const [mmTest, setMmTest] = react.useState(null);
			const [gubenScriptDraft, setGubenScriptDraft] = react.useState("");
			const set = (k) => (e) => setAccount({ ...account, [k]: e.target.value });
			const mmModel = state.settings.minimaxModel || "MiniMax-H3";
			const mmSpec = (MM_MODELS[mmModel] ?? MM_MODELS["MiniMax-H3"]);
			const mmResolution = mmSpec.resolutions.includes(state.settings.minimaxResolution)
				? state.settings.minimaxResolution
				: mmSpec.resolutions[0];

			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: "14px" } },
				h(
					"div",
					{ style: T.card },
					h("div", { style: { fontWeight: 600 } }, "TikTok 账号"),
					h(
						"div",
						{ style: T.grid },
						h(Field, { label: "备注名" }, h("input", { style: T.input, value: account.label, onChange: set("label") })),
						h(Field, { label: "用户名 / 邮箱" }, h("input", { style: T.input, value: account.username, onChange: set("username") })),
						h(Field, { label: "密码" }, h("input", { style: T.input, type: "password", value: account.password, onChange: set("password") }))
					),
					h(Btn, {
						primary: true,
						disabled: busy || !account.username,
						onClick: async () => {
							await run("保存账号", () => api("/account/save", { account }));
							setAccount({ label: "", username: "", password: "" });
						}
					}, "保存账号"),
					h("div", { style: { fontSize: "12px", ...T.muted } },
						"密码明文保存在本机 state.json（0600），仅限本机自用。TikTok 常对自动登录弹验证码/二次验证，失败时请在打开的窗口里手动登录一次。"
					),
					state.accounts.length === 0
						? h("div", { style: { fontSize: "13px", ...T.muted } }, "还没有账号。")
						: state.accounts.map((a) =>
								h(
									"div",
									{ key: a.id, style: T.sub },
									h(
										"div",
										{ style: T.row },
										h("span", { style: { ...T.tag, ...(a.status === "ok" ? { color: "#30a46c", borderColor: "#30a46c" } : a.status === "need_manual" || a.status === "locked" ? { color: "#e5484d", borderColor: "#e5484d" } : {}) } }, a.status ?? "unknown"),
										h("strong", null, a.label || a.username),
										h("span", { style: { fontSize: "12px", ...T.muted } }, a.username),
										a.hasPassword ? h("span", { style: { fontSize: "11px", ...T.muted } }, "已保存密码") : null
									),
									a.note ? h("div", { style: { fontSize: "12px", ...T.muted } }, a.note) : null,
									(() => {
										// 冷却中就别给点「登录」——频繁重试会被 TikTok 锁号
										const until = Number(a.loginBlockedUntil ?? 0);
										const left = until - Date.now();
										if (!(left > 0)) {
											return a.loginAttempts
												? h("div", { style: { fontSize: "11px", ...T.muted } }, `连续失败 ${a.loginAttempts} 次`)
												: null;
										}
										return h(
											"div",
											{ style: { fontSize: "11px", color: "#d9a441" } },
											`登录冷却中，约 ${Math.ceil(left / 60000)} 分钟后可重试（${new Date(until).toLocaleString()}）。频繁重试会导致账号被平台锁定。`
										);
									})(),
									h(
										"div",
										{ style: T.row },
										h(Btn, {
											disabled: busy || Number(a.loginBlockedUntil ?? 0) > Date.now(),
											onClick: () => run("登录 TikTok", () => api("/account/login", { id: a.id }))
										}, "登录"),
										Number(a.loginBlockedUntil ?? 0) > Date.now()
											? h(Btn, { disabled: busy, onClick: () => run("重置登录冷却", () => api("/account/reset-cooldown", { id: a.id })) }, "我已确认可重试")
											: null,
										h(Btn, { disabled: busy, onClick: () => run("删除账号", () => api("/account/delete", { id: a.id })) }, "删除")
									)
								)
							)
				),
				h(
					"div",
					{ style: T.card },
					h("div", { style: { fontWeight: 600 } }, "顾本素材库"),
					h(Field, { label: "API Token" },
						h("input", {
							style: T.input,
							type: "password",
							value: token,
							placeholder: state.settings.gubenToken ? "已配置（留空则不修改）" : "粘贴素材网「个人中心 → Agent 接入」的 Token",
							onChange: (e) => setToken(e.target.value)
						})
					),
					h(Btn, {
						primary: true,
						disabled: busy || !token.trim(),
						onClick: async () => {
							await run("保存 Token", () => api("/settings", { settings: { gubenToken: token } }));
							setToken("");
						}
					}, "保存 Token"),
					h(Field, { label: "CLI 路径（可选，留空就用插件内联的那份）" },
						h("input", {
							style: T.input,
							value: gubenScriptDraft,
							placeholder: state.gubenScriptResolved ? `内联副本：${state.gubenScriptResolved}` : "内联副本缺失，请填绝对路径",
							onChange: (e) => setGubenScriptDraft(e.target.value)
						})
					),
					h(Btn, {
						disabled: busy || gubenScriptDraft.trim() === String(state.settings.gubenScript ?? ""),
						onClick: async () => {
							await run("保存 CLI 路径", () => api("/settings", { settings: { gubenScript: gubenScriptDraft } }));
							setGubenScriptDraft("");
						}
					}, "保存 CLI 路径"),
					h(Btn, {
						disabled: busy || !state.settings.gubenScript,
						onClick: async () => {
							await run("恢复内联副本", () => api("/settings", { settings: { gubenScript: "" } }));
							setGubenScriptDraft("");
						}
					}, "恢复内联副本"),
					h("div", { style: { fontSize: "12px", ...T.muted } },
						`素材网地址：${state.settings.gubenBase}`
					),
					h("div", { style: { fontSize: "12px", ...T.muted } },
						state.settings.gubenScript
							? `当前用的是你指定的 CLI：${state.settings.gubenScript}`
							: `当前用的是插件内联的 CLI：${state.gubenScriptResolved || "（缺失）"}`
					)
				),
				h(
					"div",
					{ style: T.card },
					h("div", { style: { fontWeight: 600 } }, "MiniMax H3（视频生成）"),
					h(Field, { label: "API Token" },
						h("input", {
							style: T.input,
							type: "password",
							value: mmToken,
							placeholder: state.settings.minimaxToken ? "已配置（留空则不修改）" : "粘贴 MiniMax 开放平台的接口密钥",
							onChange: (e) => setMmToken(e.target.value)
						})
					),
					h(Field, { label: "平台域名" },
						h(
							"select",
							{
								style: T.input,
								value: state.settings.minimaxBase ?? "https://api.minimax.cn",
								onChange: (e) => run("切换 MiniMax 域名", () => api("/settings", { settings: { minimaxBase: e.target.value } }))
							},
							MM_BASES.map((b) => h("option", { key: b.value, value: b.value }, b.label))
						)
					),
					h(Field, { label: "模型" },
						h(
							"select",
							{
								style: T.input,
								value: mmModel,
								onChange: (e) => run("切换 MiniMax 模型", () => api("/settings", { settings: { minimaxModel: e.target.value } }))
							},
							Object.keys(MM_MODELS).map((k) => h("option", { key: k, value: k }, MM_MODELS[k].label))
						)
					),
					h(Field, { label: "分辨率" },
						h(
							"select",
							{
								style: T.input,
								value: mmResolution,
								onChange: (e) => run("切换 MiniMax 分辨率", () => api("/settings", { settings: { minimaxResolution: e.target.value } }))
							},
							mmSpec.resolutions.map((r) => h("option", { key: r, value: r }, r))
						)
					),
					h(Btn, {
						primary: true,
						disabled: busy || !mmToken.trim(),
						onClick: async () => {
							await run("保存 MiniMax Token", () => api("/settings", { settings: { minimaxToken: mmToken } }));
							setMmToken("");
						}
					}, "保存 Token"),
					h(
						Btn,
						{
							disabled: busy,
							onClick: async () => {
								setMmTest(null);
								try {
									// 走只读的查询接口，不建任务、不花钱，所以可以随便点
									const r = await run("测试连接", () => api("/minimax/test", {}));
									setMmTest(r.probe ?? null);
								} catch (err) {
									setMmTest({ ok: false, message: err instanceof Error ? err.message : String(err) });
								}
							}
						},
						"测试连接"
					),
					mmTest
						? h(
								"div",
								{
									style: {
										fontSize: "12px",
										padding: "8px 10px",
										borderRadius: "8px",
										border: `1px solid ${mmTest.ok ? "#30a46c" : "#e5484d"}`,
										color: mmTest.ok ? "#30a46c" : "#e5484d",
										wordBreak: "break-word"
									}
								},
								(mmTest.ok ? "✓ 连接正常：" : "✗ 连接失败：") + (mmTest.message ?? ""),
								mmTest.hint ? h("div", { style: { marginTop: "4px", ...T.muted, color: "inherit" } }, mmTest.hint) : null
							)
						: null,
					h("div", { style: { fontSize: "12px", ...T.muted } },
						`${mmSpec.label}：时长 ${mmSpec.minDuration}~${mmSpec.maxDuration} 秒，可用分辨率 ${mmSpec.resolutions.join(" / ")}；` +
						"任务时长会被自动夹到该区间。生成时在任务详情里选「顾本素材库」或「MiniMax-H3」。"
					)
				)
			);
		}

		// ------------------------------------------------------------ 外壳与座位注册

		/**
		 * 共享 store：主面板只挂一次，但四个页签共用同一份状态。
		 * 用 useSyncExternalStore 订阅，避免每个页签各拉一份。
		 */
		const store = {
			version: 0,
			state: null,
			error: "",
			ok: "",
			busy: false,
			refreshing: false,
			lastLoadedAt: null,
			listeners: new Set(),
			subscribe(fn) {
				this.listeners.add(fn);
				return () => this.listeners.delete(fn);
			},
			bump() {
				this.version += 1;
				for (const fn of [...this.listeners]) {
					try {
						fn();
					} catch {}
				}
			},
			set(patch) {
				Object.assign(this, patch);
				this.bump();
			},
			load() {
				// 之前刷新没有任何视觉反馈，点了像没反应——补上「刷新中」和最后刷新时间
				this.set({ refreshing: true });
				api("/state", undefined, "GET").then(
					(body) => this.set({ state: body.state, error: "", refreshing: false, lastLoadedAt: new Date() }),
					(err) => this.set({ error: err instanceof Error ? err.message : String(err), refreshing: false })
				);
			},
			async run(label, fn) {
				this.set({ busy: true, error: "", ok: label + "…" });
				try {
					const result = await fn();
					if (result?.state) this.set({ state: result.state });
					this.set({ ok: label + "：完成" });
					return result;
				} catch (err) {
					// 失败时也把服务端最新的 state 应用上，否则界面会停在旧状态
					if (err && err.state) this.set({ state: err.state });
					this.set({ error: label + "失败：" + (err instanceof Error ? err.message : String(err)), ok: "" });
					throw err;
				} finally {
					this.set({ busy: false });
				}
			}
		};

		const useStore = () => {
			(0, react.useSyncExternalStore)(store.subscribe.bind(store), () => store.version);
			return store;
		};

		/** 页签定义：都在同一个主面板里，切换只换内容。 */
		const TABS = [
			{ id: "tasks", label: "运营任务", hint: "提交选题、跟进度、审核", page: TasksTab },
			{ id: "data", label: "视频数据", hint: "观看 / 点赞 / 评论 / 分享", page: DataTab },
			{ id: "comments", label: "评论", hint: "用户对已发布视频的评论", page: CommentsTab },
			{ id: "insights", label: "运营洞察", hint: "用数据反哺下一轮选题", page: InsightsTab }
		];

		/** 主面板：顶部页签 + 内容区。 */
		function OpsPanel() {
			const s = useStore();
			const [tab, setTab] = react.useState("tasks");
			const [newOpen, setNewOpen] = react.useState(false);
			react.useEffect(() => {
				if (store.state === null) store.load();
			}, []);

			if (s.error && !s.state) {
				return h("div", { style: { padding: "20px", fontSize: "13px", color: "var(--dsh-color-danger, #e5484d)" } }, "宿主接口不可用：" + s.error);
			}
			if (!s.state) return h("div", { style: { padding: "20px", fontSize: "13px", ...T.muted } }, "正在读取状态…");

			const active = TABS.find((t) => t.id === tab) ?? TABS[0];
			const props = { state: s.state, run: (l, f) => store.run(l, f), busy: s.busy };

			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", height: "100%", boxSizing: "border-box" } },
				h(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: "10px", borderBottom: "1px solid var(--dsh-color-border, rgba(128,128,128,.25))" } },
					h(
						"div",
						{ style: { ...T.row, gap: "8px" } },
						TABS.map((t) =>
							h(
								"button",
								{
									key: t.id,
									type: "button",
									style: {
										...T.btn,
										borderBottomLeftRadius: 0,
										borderBottomRightRadius: 0,
										borderBottom: "none",
										...(tab === t.id ? { borderColor: "var(--dsh-color-accent, #4c8dff)", fontWeight: 600, color: "var(--dsh-color-accent, #4c8dff)" } : {})
									},
									onClick: () => setTab(t.id)
								},
								t.label
							)
						),
						h("span", { style: { flex: 1 } }),
						h("span", { style: { fontSize: "12px", ...T.muted } }, active.hint),
						active.id === "tasks" ? h(Btn, { primary: true, disabled: s.busy, onClick: () => setNewOpen(true) }, "新建任务") : null,
						s.lastLoadedAt
							? h("span", { style: { fontSize: "11px", ...T.muted } }, `最后刷新 ${s.lastLoadedAt.toLocaleTimeString()}`)
							: null,
						h(Btn, { disabled: s.busy || s.refreshing, onClick: () => store.load() }, s.refreshing ? "刷新中…" : "刷新")
					)
				),
				h(
					"div",
					{
						style: {
							flex: 1,
							minHeight: 0,
							// 看板自己横向排列 + 各列纵向滚动，所以外层不能滚动；其余页签整体滚动
							overflow: active.id === "tasks" ? "hidden" : "auto",
							padding: "14px 16px 16px",
							display: "flex",
							flexDirection: "column",
							gap: "12px"
						}
					},
					h(Banner, { kind: "err", text: s.error }),
					h(Banner, { kind: "ok", text: s.busy ? s.ok : "" }),
					h(active.page, props)
				),
				h(NewTaskModal, { state: s.state, run: props.run, busy: s.busy, open: newOpen, onClose: () => setNewOpen(false) })
			);
		}

		/** 侧栏图标。 */
		function OpsIcon(props) {
			const size = props?.size ?? 18;
			return h(
				"svg",
				{ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round" },
				h("path", { d: "M9 11l3 3L22 4" }),
				h("path", { d: "M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" })
			);
		}

		/** 侧栏与主面板共用的唯一标识：layout.selectPanel 靠它切换。 */
		const PANEL_ID = "tiktok-ops";
		const SETTINGS_ORDER = 160;

		const inject = ["slots"];

		function apply(ctx) {
			// 1) 设置弹窗里**只**放设置（TikTok 账号 + 顾本 Token）
			ctx.slots.inject("settings.section", () => {
				try {
					const unregister = ctx.slots.register(
						{
							name: "settings.section",
							id: "dsh-tiktok-ops",
							order: SETTINGS_ORDER,
							label: () => "TikTok 运营助手",
							// 插槽约定：inject 必须是「返回 props 的函数」
							inject: () => ({})
						},
						function SettingsSection() {
							const s = useStore();
							react.useEffect(() => {
								if (store.state === null) store.load();
							}, []);
							if (!s.state) return h("div", { style: { fontSize: "13px", ...T.muted } }, "正在读取状态…");
							return h(
								"div",
								{ style: { display: "flex", flexDirection: "column", gap: "12px" } },
								h(Banner, { kind: "err", text: s.error }),
								h(Banner, { kind: "ok", text: s.busy ? s.ok : "" }),
								h(SettingsTab, { state: s.state, run: (l, f) => store.run(l, f), busy: s.busy })
							);
						}
					);
					return () => {
						try {
							unregister();
						} catch {}
					};
				} catch {
					return () => {};
				}
			});

			// 2) 左侧导航栏只放一个入口
			ctx.slots.inject("sidebar.panellist", () => {
				try {
					const unregister = ctx.slots.register(
						{ name: "sidebar.panellist", id: PANEL_ID, order: 211, label: () => "TikTok 运营助手" },
						OpsIcon
					);
					return () => {
						try {
							unregister();
						} catch {}
					};
				} catch {
					return () => {};
				}
			});

			// 3) 主面板：四个页面做成页内页签
			ctx.slots.inject("main", () => {
				try {
					// key 必须与 sidebar.panellist 的 id 一致
					const unregister = ctx.slots.register({ name: "main", key: PANEL_ID }, OpsPanel);
					return () => {
						try {
							unregister();
						} catch {}
					};
				} catch {
					return () => {};
				}
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		// 离线冒烟测试用（scripts/test-client.mjs）：浏览器侧只认 apply / inject，
		// 这里多导出一份内部件，好在没有浏览器的情况下也能把渲染路径跑一遍。
		exports.internals = {
			OpsPanel,
			TaskDetailModal,
			TaskCard,
			MaterialPickerModal,
			MaterialRow,
			NewTaskModal,
			SettingsTab,
			api,
			parseRefs,
			uploadMaterialFile,
			materialKey
		};
		return module.exports;
	}
});
