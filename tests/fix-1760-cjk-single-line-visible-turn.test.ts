import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginChatWithStrip } from "../src/plugin.ts";
import { setLogCapture } from "../src/logger.ts";
import { isOrphanMarkupText } from "../src/loop/tag-echo-filter.ts";
import type { Session } from "../src/session.ts";

function makeSession(): Session {
    return {
        id: "testsess",
        protocol: "openai",
        upstreamOrigin: "http://127.0.0.1:9/v1",
        label: "test",
        createdAt: 0,
        lastUsedAt: 0,
        requests: 0,
        lastInputTokens: 0,
        stats: {},
        dirty: false,
    } as unknown as Session;
}

function makeRes(chunks: string[]) {
    return {
        writes: chunks,
        write(b: Buffer | string) {
            chunks.push(typeof b === "string" ? b : b.toString("utf8"));
            return true;
        },
        end(b?: Buffer | string) {
            if (b !== undefined) chunks.push(typeof b === "string" ? b : b.toString("utf8"));
        },
        once() {},
        destroyed: false,
        writableEnded: false,
    } as unknown as import("node:http").ServerResponse;
}

function streamOf(events: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < events.length) {
                controller.enqueue(enc.encode(events[i]));
                i += 1;
            } else {
                controller.close();
            }
        },
    });
}

function chatChunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
}

function chatStop(): string {
    return chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
}

const DONE = "data: [DONE]\n\n";

function textDeltas(raw: string): string {
    return [...raw.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string).join("");
}

test("#1760 isOrphanMarkupText: prose releases are not residue, markup releases are", () => {
    // Held CJK prose (the marker-line filter's content preservation).
    assert.equal(isOrphanMarkupText("好"), false, "single CJK char");
    assert.equal(isOrphanMarkupText("你好，世界"), false, "CJK prose");
    assert.equal(isOrphanMarkupText("汉字 abc"), false, "mixed CJK prose");
    assert.equal(isOrphanMarkupText("→ 箭头"), false, "symbol-led prose is not a forged marker");
    assert.equal(isOrphanMarkupText("café"), false, "accented latin prose");
    // Held markup the filter declined to swallow.
    assert.equal(isOrphanMarkupText("<a"), true, "partial render-tag head");
    assert.equal(isOrphanMarkupText("\x3cacp"), true, "longer partial render-tag head");
    assert.equal(isOrphanMarkupText("\x3cacp tokens=\"247\" type=\"text\"\x3e"), true, "complete render tag");
    assert.equal(isOrphanMarkupText("ok \x3c/acp"), true, "orphan close in the release");
    assert.equal(isOrphanMarkupText("📦 [ACP] Compressed m00120"), true, "forged marker line");
    assert.equal(isOrphanMarkupText(""), false, "empty release");
});

/** The production shape of #1760, taken from the upstream stream recorded on
 *  2026-09-30: a role frame, ONE content delta carrying the whole answer, then a
 *  terminal frame whose content field is empty. The answer is a single CJK
 *  character, so every byte of it is still held by the marker-line filter's
 *  line-start lookahead (MARKER_HEAD_PREFIX accepts any non-ASCII lead) when the
 *  terminal arrives, and the terminal's own fold releases it. */
function singleCharCjkTurn(): string[] {
    return [
        chatChunk({ role: "assistant", content: null, reasoning_content: "" }),
        chatChunk({ content: "好", reasoning_content: null }),
        chatChunk({ content: "", reasoning_content: null }, { choices: [{ index: 0, delta: { content: "", reasoning_content: null }, finish_reason: "stop" }] }),
        DONE,
    ];
}

test("#1760: a single-line CJK answer reaches the client and is not a degenerate turn", async () => {
    const logs: string[] = [];
    setLogCapture((_level, msg) => {
        logs.push(msg);
    });
    try {
        const out: string[] = [];
        let calls = 0;
        const refetch = () => {
            calls += 1;
            return Promise.resolve(streamOf([chatChunk({ role: "assistant" }), chatChunk({ content: "retry" }), chatStop(), DONE]));
        };
        await pipePluginChatWithStrip(streamOf(singleCharCjkTurn()), makeRes(out), "openai", makeSession(), undefined, refetch);
        const text = out.join("");
        assert.equal(calls, 0, "the answer reached the client: no re-issue");
        assert.equal(textDeltas(text), "好", "the held single-char answer reaches the client");
        assert.ok(!text.includes("[ACP] stream error"), "no in-band error");
        assert.ok(!logs.some((l) => l.includes("[degenerate-turn]")), `no degenerate warn, got: ${logs.join(" | ")}`);
        assert.equal((text.match(/\[DONE\]/g) ?? []).length, 1, "one turn, one terminal");
    } finally {
        setLogCapture(null);
    }
});

test("#1760 control: a held partial tag head is still residue, so the turn is re-issued", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf([chatChunk({ role: "assistant" }), chatChunk({ content: "real answer after the nudge" }), chatStop(), DONE]));
    };
    const events = [chatChunk({ role: "assistant" }), chatChunk({ content: "\x3ca" }), chatStop(), DONE];
    await pipePluginChatWithStrip(streamOf(events), makeRes(out), "openai", makeSession(), undefined, refetch);
    const text = out.join("");
    assert.equal(calls, 1, "orphan markup is not visible output: exactly one re-issue");
    // The first attempt's drained residue goes with its dropped terminal, so what
    // the client keeps is the retry's answer (same contract as the #870 fixtures).
    assert.ok(textDeltas(text).endsWith("real answer after the nudge"), "the retry's content reaches the client");
});
