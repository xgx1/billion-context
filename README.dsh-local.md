# 本地改动（MyAI 部署 fork）

上游：`ranxianglei/billion-context`（本仓 `upstream` remote）；`origin` = `xgx1/billion-context`。
本 fork 只带下面这一处本地改动。同步上游时按此清单重放，不要 `-X theirs` 一把推平。

## `compat.dropFields`：按 provider 删除客户端固定发送的字段

**为什么**：SenseNova 的 OpenAI Responses 全兼容端点（`https://token.sensenova.cn/v1/responses`）是严格 schema——遇到不认识的字段直接 `400 json: unknown field "…"`。而 pi-ai（DeepSeek Harness 的 `llm-pi-ai` 层）只要请求了思考档位就必发 `reasoning.summary: "auto"`（`@earendil-works/pi-ai/dist/api/openai-responses.js:260`），于是整条 Responses 车道 400。

**实测（2026-09-30，同一 model 逐条 curl）**：pi-ai 出站体的 `include` / `prompt_cache_key` / `store` / `max_output_tokens` / `stream` 上游全部接受，**唯一被拒的是 `reasoning.summary`**；去掉它后整份 body（含 tools 与 SSE）返回 200。所以这是一行宽的兼容缺口，不是车道不可用。

**改了什么**：
- `src/compat-drop.ts`（新增）：`parseCompatDropFields` / `resolveCompatDropFields` / `dropCompatFieldsJson` / `applyCompatDropFields`。
- `src/config.ts`：把 `compat.dropFields` 接到全局与 per-provider 两条解析路径（与 `compat.roles` 共用同一条最长前缀匹配）。
- `src/server.ts`：在 `compat.roles` 所在的**同一个最终转发边界**应用；`wireTransform` 同步应用，使压缩重试的重发体与首次转发一致。
- `tests/compat-drop.test.ts`（新增，5 个用例）。

**配置形状的映射依据**（上游 AGENTS.md 的 config-surface 纪律要求说明）：没有新开 section——只是给既有的 `compat` 块加了一个与 `roles` 同物种的键，语义同样是「按上游的 wire 约束改写最终出站体」，应用点也完全相同。

**用法**：

```jsonc
{
  "providers": {
    "https://token.sensenova.cn/v1": {
      "compat": { "dropFields": ["reasoning.summary"] }
    }
  }
}
```

路径不存在时不重序列化（默认路径保持 byte-for-byte），命中时日志打 `[compat] dropped reasoning.summary per compat.dropFields`。

**上游化状态**：已按上游 AGENTS.md 的要求提 issue 请 owner 裁定配置形状（若是具名开关如 `supportsReasoningSummary: false`，按 owner 的形状改）。在上游给出正式形状前，本 fork 保留此实现。

## `BILI_NATIVE_DSH_LANE`：dsh 车道的 lane 可覆盖（多实例隔离）

**为什么**：attach 的兼容判定按 `lane` 匹配（`instanceCompatible`，`src/launcher.ts:2496`），而 dsh 车道的 lane 硬编码为 `"dsh"`（`src/agent/dsh-native.ts`）。同一台机器上跑两个 dsh 部署（生产 `~/.dsh` 与开发 worktree `~/.dsh-dev`）时，后启动的那个会 attach 到先启动那个的代理；而该代理的生命周期绑在拉起它的 dsh 进程上（父进程 watchdog），于是**任何一个实例重启都会把另一个正在用的模型链路一起带走**——且没有回退路径。

**改了什么**：`src/agent/dsh-native.ts` 的 spawn 调用改为 `lane: dshLane(process.env)`，读 `BILI_NATIVE_DSH_LANE`；未设置时仍是历史值 `"dsh"`。两个实例的启动脚本各导出自己的 lane（生产 `dsh-prod`、dev `dsh-dev`），zone 端口按 lane sticky 分配，互不干扰，生命周期各自归各自。

**上游化状态**：未单独提 issue（避免对同一仓库重复发帖）。若上游愿意收，这是一个 3 行改动 + 一条 env 文档，可作为独立 PR。

## 退化误判：单行中文答案被当成「零可见输出」

**为什么**：`mayStartMarkerLine`（`src/loop/tag-echo-filter.ts:193-195`）用 `MARKER_TAIL` 判定「可能是伪造 marker 行的开头」，而该模式匹配**任何以非 ASCII 字符开头的行**（CJK、重音字母、astral 图标）。于是中文回答不走 `src/plugin.ts:1550` 的快速通道，而是进 marker 过滤器；marker 过滤器按设计扣住非 ASCII 行首前缀（`MARKER_HEAD_PREFIX`，`:180`，注释 `:174-179` 说「Holding is cheap and lossless」），其 flush（`:851-865`）明确把扣住的文本当**内容**放行（«Undecidable prefix or plain tail: content preservation»）。但 `#1546`/`2c86f635` 加的终点记账（`src/plugin.ts:1390-1404` 的 `flushTails()`、`src/plugin.ts:1576-1586` 与 `:1761-1770` 的两处终端折叠）把**释放出来的每一个字符都计进 `releasedMarkupChars`**，于是 `visibleTextChars === releasedMarkupChars`，退化门（`src/plugin.ts:1310`、`:1326`）判为空轮 → 重试 → 再判 → `src/plugin.ts:1319` 报 `the turn degenerated again after the continuation nudge`，整轮失败。

**实测（2026-09-30）**：提示「只回一个字：好」，模型 `deepseek-flash` @ low，上游 api.deepseek.com。经 bili 稳定失败；`BILI_NATIVE_DSH=0` 直连返回「好」。本地录制器录到上游**确实发了** `{"delta":{"content":"好"}}`，三次请求（首试、重试、旁路）都带该内容——是插件侧误判，不是上游空回答。**影响面**：所有「整段可见输出被扣住的单行中文回答」（多行回答会在下一字符处释放，故不受影响）；Responses 车道另有 `heldVisibleChars`（`src/plugin.ts:2052`、`:2335`、门 `:2182`），所以同一提示在 sensenova Responses 线正常——只有 chat-completions 线中招。

**改了什么**：
- `src/loop/tag-echo-filter.ts`（新增导出）：`isOrphanMarkupText(s)` = `mayStartRenderTag(s) || containsMarkerLineText(s) || mayStartBiliInternal(s)`——判定「释放出来的这段文本是否仍携带 host 无法处理的 markup」。`containsMarkerLineText` 只认字面 `[ACP]`、`mayStartRenderTag` 的 `PARTIAL_TAIL` 要求字面 `<`，所以 CJK 散文为 false、`"\x3ca"` 这类被扣的部分 tag 头仍为 true。
- `src/plugin.ts` 三处记账改为按字节分类：`flushTails()` 与两处终端折叠只在 `isOrphanMarkupText(...)` 为真时把长度计进 `releasedMarkupChars`；`droppedTagInFrame`（#870 的精确机制）原样保留，未闭合 tag 内部文字仍算残渣、仍会重试一次。
- `tests/fix-1760-cjk-single-line-visible-turn.test.ts`（新增，3 个用例）：分类单元断言；生产形状回归（`calls === 0`、客户端收到「好」、无 stream error、无 `[degenerate-turn]` 日志）；`"\x3ca"` 对照（仍 `calls === 1`）。

**配置形状的映射依据**：无新增 config 键、无新增环境变量——只是把既有的「释放文本算不算残渣」判定做成一个按字节分类的纯函数，属于修 bug，不扩配置面。

**上游化状态**：已提 issue（<https://github.com/ranxianglei/billion-context/issues/1760>），并说明若 owner 想要别的门（例如由 marker 过滤器上报「真正丢弃的 markup 字符数」而不是在 plugin 侧按字节分类）可按 owner 的形状改。
