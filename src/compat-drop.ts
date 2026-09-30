import type { ProviderRoutes } from "./config.js";
import { findRoute } from "./config.js";

/** Dotted request-body paths to delete before forwarding (for example
 *  `reasoning.summary`). A provider whose request schema is narrower than the
 *  spec the client implements answers 400 "json: unknown field" for a field
 *  the client always sends; deleting it at the forward boundary keeps every
 *  other upstream byte-identical. */
export type CompatDropFields = readonly string[];

/** Field-path shape accepted from config: identifiers separated by dots. */
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Validate a `compat.dropFields` value: an array of dotted identifiers.
 *  Malformed entries are dropped rather than failing the proxy; returns
 *  undefined when nothing usable is left. */
export function parseCompatDropFields(v: unknown): string[] | undefined {
    if (!Array.isArray(v)) return undefined;
    const out = v.filter((entry): entry is string => typeof entry === "string" && PATH_RE.test(entry));
    return out.length > 0 ? out : undefined;
}

/** Merge the drop list for one request: global `compat.dropFields` plus the
 *  per-provider route entry (longest-URL-prefix match, identical to the
 *  compress-settings lookup). Provider entries add to the global list — a
 *  provider cannot un-drop a global field. Empty when unconfigured, which
 *  keeps the default path byte-for-byte transparent. */
export function resolveCompatDropFields(
    routes: ProviderRoutes,
    upstreamUrl: string | undefined,
    globalFields: CompatDropFields | undefined,
): string[] {
    const providerFields = findRoute(routes, upstreamUrl)?.compat?.dropFields;
    if (!globalFields?.length && !providerFields?.length) return [];
    return [...new Set([...(globalFields ?? []), ...(providerFields ?? [])])];
}

/** Object-level drop shared by the forward boundary (string body) and the
 *  compress-retry loops (parsed body). Absent paths are left alone, and the
 *  parent chain must already be an object, so a path never creates structure.
 *  Mutates `parsed` in place; returns the paths actually deleted. */
export function dropCompatFieldsJson(parsed: Record<string, unknown>, fields: CompatDropFields): string[] {
    const dropped: string[] = [];
    for (const path of fields) {
        const parts = path.split(".");
        let node: Record<string, unknown> = parsed;
        let reachable = true;
        for (const key of parts.slice(0, -1)) {
            const next = node[key];
            if (!next || typeof next !== "object" || Array.isArray(next)) {
                reachable = false;
                break;
            }
            node = next as Record<string, unknown>;
        }
        const leaf = parts[parts.length - 1];
        if (reachable && Object.prototype.hasOwnProperty.call(node, leaf)) {
            delete node[leaf];
            dropped.push(path);
        }
    }
    return dropped;
}

/** Apply the drop list to a serialized request body. Returns the original
 *  string (no re-stringify) when no path was present, so bodies that never
 *  carried the field stay byte-identical. */
export function applyCompatDropFields(
    body: string,
    fields: CompatDropFields,
): { body: string; dropped: string[] } {
    if (fields.length === 0) return { body, dropped: [] };
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
        return { body, dropped: [] };
    }
    const dropped = dropCompatFieldsJson(parsed, fields);
    if (dropped.length === 0) return { body, dropped: [] };
    return { body: JSON.stringify(parsed), dropped };
}
