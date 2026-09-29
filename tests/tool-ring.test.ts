// #1685 zero-injection session identity: unit coverage for the outbound
// tool_use witness ring plus the handlePluginTool routing ladder that consumes
// it (witness → body id → single-active arbitration → loud 400).
import assert from "node:assert/strict";
import http from "node:http";
import { beforeEach, describe, it } from "node:test";

import { createCore, defaultConfig } from "acp-kernel";
import { type PluginToolDeps, _resetPluginStateForTest, handlePluginTool, recordPluginSession } from "../src/plugin.ts";
import { getSession } from "../src/session.ts";
import {
    _toolRingSizeForTest,
    lookupToolWitness,
    normalizeToolName,
    recordToolWitness,
    resetToolRingForTest,
    witnessHash,
} from "../src/tool-ring.ts";

function mockRes(): { res: http.ServerResponse; status(): number; body(): string } {
    let body = "";
    let status = 0;
    const res = {
        writeHead: (code: number) => { status = code; return undefined; },
        end: (chunk: unknown) => { body = String(chunk ?? ""); },
    } as unknown as http.ServerResponse;
    return { res, status: () => status, body: () => body };
}

describe("#1685 tool-ring unit", () => {
    beforeEach(() => {
        resetToolRingForTest();
    });

    it("normalizeToolName strips host prefixes both sides", () => {
        assert.equal(normalizeToolName("compress"), "compress");
        assert.equal(normalizeToolName("mcp__bili__compress"), "compress");
        assert.equal(normalizeToolName("host__pkg__acp_status"), "acp_status");
        assert.equal(normalizeToolName("mcp__bili-compress"), "bili-compress", "non-standard single-underscore pkg form does not fully strip");
    });

    it("record → lookup round-trip names the session", () => {
        recordToolWitness("s1", "compress", JSON.stringify({ startId: "m00001", endId: "m00009", summary: "nine msgs" }));
        const hits = lookupToolWitness("compress", JSON.stringify({ startId: "m00001", endId: "m00009", summary: "nine msgs" }));
        assert.deepEqual([...hits], ["s1"]);
    });

    it("host-prefixed record matches bare lookup (and vice versa)", () => {
        recordToolWitness("s1", "mcp__bili__compress", "{}");
        assert.equal(lookupToolWitness("compress", "{}").size, 1);
        recordToolWitness("s2", "compress", "{}");
        // both now hold the same normalized hash → collision set
        assert.deepEqual([...lookupToolWitness("mcp__other__compress", "{}")].sort(), ["s1", "s2"]);
    });

    it("legacy conversation_id is stripped from the hash (#760 parity)", () => {
        const withId = witnessHash("compress", { conversation_id: "pfa-legacy", startId: "m1", summary: "x" });
        const withoutId = witnessHash("compress", { startId: "m1", summary: "x" });
        assert.equal(withId, withoutId);
        recordToolWitness("s1", "compress", JSON.stringify({ conversation_id: "pfa-legacy", startId: "m1", summary: "x" }));
        assert.equal(lookupToolWitness("compress", JSON.stringify({ startId: "m1", summary: "x" })).size, 1);
    });

    it("argument key order is irrelevant (stableStringify)", () => {
        recordToolWitness("s1", "compress", JSON.stringify({ summary: "s", startId: "m00001", endId: "m00002" }));
        const hits = lookupToolWitness("compress", JSON.stringify({ endId: "m00002", startId: "m00001", summary: "s" }));
        assert.deepEqual([...hits], ["s1"]);
    });

    it("no-arg tools: string {} and object {} hash the same; empty string ≡ {}", () => {
        assert.equal(witnessHash("acp_status", "{}"), witnessHash("acp_status", {}));
        assert.equal(witnessHash("acp_status", ""), witnessHash("acp_status", "{}"));
    });

    it("unparseable argument JSON never records", () => {
        recordToolWitness("s1", "compress", "{not json");
        assert.equal(_toolRingSizeForTest(), 0);
        assert.equal(witnessHash("compress", "{not json"), "");
    });

    it("capacity eviction drops the oldest hash from the index too", () => {
        const first = JSON.stringify({ n: 0 });
        recordToolWitness("s1", "compress", first);
        for (let i = 1; i <= 32; i++) recordToolWitness("s1", "compress", JSON.stringify({ n: i }));
        // 33 distinct records → first was evicted (ring keeps 32)
        assert.equal(lookupToolWitness("compress", first).size, 0, "evicted witness no longer matches");
        assert.equal(lookupToolWitness("compress", JSON.stringify({ n: 1 })).size, 1, "second-oldest still resident");
    });

    it("multi-session collision returns the full candidate set", () => {
        const args = JSON.stringify({ startId: "m00001", endId: "m00002", summary: "identical" });
        recordToolWitness("s1", "compress", args);
        recordToolWitness("s2", "compress", args);
        assert.deepEqual([...lookupToolWitness("compress", args)].sort(), ["s1", "s2"]);
    });

    it("no witness → empty set, never a guess", () => {
        assert.equal(lookupToolWitness("compress", JSON.stringify({ summary: "never seen" })).size, 0);
    });
});

describe("#1685 handlePluginTool routing ladder", () => {
    let deps: PluginToolDeps;
    let logs: string[];

    beforeEach(() => {
        _resetPluginStateForTest();
        resetToolRingForTest();
        logs = [];
        deps = { core: createCore(), config: defaultConfig(400_000), log: (_lvl: string, msg: string) => { logs.push(msg); } };
    });

    async function post(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
        const out = mockRes();
        await handlePluginTool(JSON.stringify(body), out.res, deps);
        return { status: out.status(), json: JSON.parse(out.body()) as Record<string, unknown> };
    }

    function executedOn(): string[] {
        return logs.filter((m) => m.includes("executed via plugin")).map((m) => m.split("]")[0]?.slice(1) ?? "");
    }

    it("id-less POST with a unique witness routes by witness", async () => {
        const a = getSession(`t-1685-wa-${Math.random().toString(36).slice(2)}`);
        const b = getSession(`t-1685-wb-${Math.random().toString(36).slice(2)}`);
        recordToolWitness(a.id, "acp_status", "{}");
        const r = await post({ tool: "acp_status", args: {} });
        assert.equal(r.status, 200);
        assert.equal(r.json.ok, true);
        assert.deepEqual(executedOn(), [a.id]);
        assert.match(logs.join("\n"), /routed by witness, #1685/);
        assert.ok(!logs.join("\n").includes(b.id));
    });

    it("witness wins over a disagreeing body id", async () => {
        const a = getSession(`t-1685-xa-${Math.random().toString(36).slice(2)}`);
        const b = getSession(`t-1685-xb-${Math.random().toString(36).slice(2)}`);
        recordToolWitness(a.id, "acp_status", "{}");
        const r = await post({ conversationId: b.id, tool: "acp_status", args: {} });
        assert.equal(r.status, 200);
        assert.deepEqual(executedOn(), [a.id]);
        assert.match(logs.join("\n"), /differs and was ignored \(#1685\)/);
    });

    it("collision without a body id is a loud 400 with the count", async () => {
        const a = getSession(`t-1685-ca-${Math.random().toString(36).slice(2)}`);
        const b = getSession(`t-1685-cb-${Math.random().toString(36).slice(2)}`);
        recordToolWitness(a.id, "acp_status", "{}");
        recordToolWitness(b.id, "acp_status", "{}");
        const r = await post({ tool: "acp_status", args: {} });
        assert.equal(r.status, 400);
        assert.match(String(r.json.error), /witnessed in 2 sessions/);
        assert.match(String(r.json.error), /refuse to guess/);
    });

    it("collision WITH a body id still routes by the body id", async () => {
        const a = getSession(`t-1685-da-${Math.random().toString(36).slice(2)}`);
        const b = getSession(`t-1685-db-${Math.random().toString(36).slice(2)}`);
        recordToolWitness(a.id, "acp_status", "{}");
        recordToolWitness(b.id, "acp_status", "{}");
        const r = await post({ conversationId: b.id, tool: "acp_status", args: {} });
        assert.equal(r.status, 200);
        assert.deepEqual(executedOn(), [b.id]);
    });

    it("body id keeps working with no witness at all (extensions/legacy path)", async () => {
        const a = getSession(`t-1685-ba-${Math.random().toString(36).slice(2)}`);
        const r = await post({ conversationId: a.id, tool: "acp_status", args: {} });
        assert.equal(r.status, 200);
        assert.deepEqual(executedOn(), [a.id]);
        assert.match(logs.join("\n"), /routed by body, #1685/);
    });

    it("id-less POST with exactly one fresh conversation routes by arbitration", async () => {
        const a = getSession(`t-1685-aa-${Math.random().toString(36).slice(2)}`);
        recordPluginSession(`conv-1685-only-${Math.random().toString(36).slice(2)}`, a.id);
        const r = await post({ tool: "acp_status", args: {} });
        assert.equal(r.status, 200);
        assert.deepEqual(executedOn(), [a.id]);
        assert.match(logs.join("\n"), /routed by arb, #1685/);
    });

    it("id-less POST with two fresh conversations refuses to guess", async () => {
        const a = getSession(`t-1685-ta-${Math.random().toString(36).slice(2)}`);
        const b = getSession(`t-1685-tb-${Math.random().toString(36).slice(2)}`);
        recordPluginSession(`conv-1685-one-${Math.random().toString(36).slice(2)}`, a.id);
        recordPluginSession(`conv-1685-two-${Math.random().toString(36).slice(2)}`, b.id);
        const r = await post({ tool: "acp_status", args: {} });
        assert.equal(r.status, 400);
        assert.match(String(r.json.error), /2 conversations active/);
        assert.match(String(r.json.error), /refuse to guess/);
    });

    it("id-less POST with no witness and no conversations is a loud 400", async () => {
        const r = await post({ tool: "acp_status", args: {} });
        assert.equal(r.status, 400);
        assert.match(String(r.json.error), /0 conversations active/);
    });
});
