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
