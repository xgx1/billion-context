import test from "node:test";
import assert from "node:assert/strict";
import { applyCompatDropFields, dropCompatFieldsJson, parseCompatDropFields, resolveCompatDropFields } from "../src/compat-drop.ts";
import { parseRouteEntry } from "../src/config.ts";

test("parseCompatDropFields keeps dotted identifiers only", () => {
    assert.equal(parseCompatDropFields(undefined), undefined);
    assert.equal(parseCompatDropFields("reasoning.summary"), undefined);
    assert.equal(parseCompatDropFields([]), undefined);
    assert.equal(parseCompatDropFields([42, "", "9bad", "a..b", "a."]), undefined);
    assert.deepEqual(parseCompatDropFields(["reasoning.summary", "include", 42]), ["reasoning.summary", "include"]);
});

test("resolveCompatDropFields unions global and provider entries", () => {
    const routes = { "https://token.sensenova.cn/v1": { compat: { dropFields: ["reasoning.summary"] } } };
    // No match anywhere.
    assert.deepEqual(resolveCompatDropFields(routes, "https://api.other.com/v1/responses", undefined), []);
    // Provider only.
    assert.deepEqual(resolveCompatDropFields(routes, "https://token.sensenova.cn/v1/responses", undefined), ["reasoning.summary"]);
    // Global + provider: both apply, provider cannot un-drop a global field.
    assert.deepEqual(resolveCompatDropFields(routes, "https://token.sensenova.cn/v1/responses", ["include"]), ["include", "reasoning.summary"]);
    // Duplicates collapse.
    assert.deepEqual(resolveCompatDropFields(routes, "https://token.sensenova.cn/v1/responses", ["reasoning.summary"]), ["reasoning.summary"]);
});

test("dropCompatFieldsJson deletes present paths only and never builds structure", () => {
    const body: Record<string, unknown> = { model: "m", reasoning: { effort: "low", summary: "auto" }, include: ["x"] };
    assert.deepEqual(dropCompatFieldsJson(body, ["reasoning.summary", "missing.path", "reasoning.nested.deeper", "include"]), ["reasoning.summary", "include"]);
    assert.deepEqual(body, { model: "m", reasoning: { effort: "low" } });
});

test("applyCompatDropFields stays byte-identical when nothing matched", () => {
    const body = JSON.stringify({ model: "m", reasoning: { effort: "low" } });
    const untouched = applyCompatDropFields(body, ["reasoning.summary"]);
    assert.equal(untouched.body, body);
    assert.deepEqual(untouched.dropped, []);

    const dropped = applyCompatDropFields(JSON.stringify({ model: "m", reasoning: { effort: "low", summary: "auto" } }), ["reasoning.summary"]);
    assert.deepEqual(dropped.dropped, ["reasoning.summary"]);
    assert.deepEqual(JSON.parse(dropped.body), { model: "m", reasoning: { effort: "low" } });

    // Malformed JSON is returned untouched rather than failing the request.
    assert.deepEqual(applyCompatDropFields("{not json", ["model"]), { body: "{not json", dropped: [] });
});

test("parseRouteEntry carries compat.dropFields into the route", () => {
    const both = parseRouteEntry({ compat: { roles: { developer: "system" }, dropFields: ["reasoning.summary"] } });
    assert.deepEqual(both?.compat, { roles: { developer: "system" }, dropFields: ["reasoning.summary"] });
    const dropOnly = parseRouteEntry({ compat: { dropFields: ["include"] } });
    assert.deepEqual(dropOnly?.compat, { dropFields: ["include"] });
    const rolesOnly = parseRouteEntry({ compat: { roles: { developer: "system" } } });
    assert.deepEqual(rolesOnly?.compat, { roles: { developer: "system" } });
});
