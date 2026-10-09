"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseLinkFile = parseLinkFile;
const viem_1 = require("viem");
const LINK_FILE_V = 1;
const IDPS = ["microsoft", "github", "google"];
const SUB_MAX = 256;
function parseLinkFile(value) {
    if (!value || typeof value !== "object")
        return { ok: false, reason: "store-unreadable" };
    const record = value;
    if (record.v !== LINK_FILE_V) {
        if (typeof record.v === "number")
            return { ok: false, reason: "unknown-version" };
        return { ok: false, reason: "store-unreadable" };
    }
    if (!Array.isArray(record.people))
        return { ok: false, reason: "store-unreadable" };
    const people = [];
    const owners = new Set();
    const wallets = new Set();
    const subs = new Set();
    for (const row of record.people) {
        const person = asPerson(row);
        if (!person)
            return { ok: false, reason: "store-unreadable" };
        if (owners.has(person.owner))
            return { ok: false, reason: "store-unreadable" };
        owners.add(person.owner);
        let ownsWallet = false;
        for (const handle of person.handles) {
            if (handle.kind === "wallet") {
                if (wallets.has(handle.address))
                    return { ok: false, reason: "store-unreadable" };
                wallets.add(handle.address);
                if (handle.address === person.owner)
                    ownsWallet = true;
            }
            else {
                if (subs.has(handle.sub))
                    return { ok: false, reason: "store-unreadable" };
                subs.add(handle.sub);
            }
        }
        if (!ownsWallet)
            return { ok: false, reason: "store-unreadable" };
        people.push(person);
    }
    return { ok: true, file: { v: LINK_FILE_V, people } };
}
function asPerson(value) {
    if (!isRecord(value) || !Array.isArray(value.handles))
        return null;
    const owner = checksum(value.owner);
    if (!owner)
        return null;
    const handles = [];
    for (const handle of value.handles) {
        const parsed = asHandle(handle);
        if (!parsed)
            return null;
        handles.push(parsed);
    }
    return { owner, handles };
}
function asHandle(value) {
    if (!isRecord(value))
        return null;
    if (value.kind === "wallet") {
        const address = checksum(value.address);
        if (!address)
            return null;
        return { kind: "wallet", address };
    }
    if (value.kind === "oauth") {
        const sub = cleanSub(value.sub);
        const idp = cleanIdp(value.idp);
        if (!sub || idp === "invalid")
            return null;
        return { kind: "oauth", sub, idp };
    }
    return null;
}
function checksum(value) {
    if (typeof value !== "string" || !value.trim())
        return null;
    try {
        return (0, viem_1.getAddress)(value.trim());
    }
    catch {
        return null;
    }
}
function cleanSub(value) {
    if (typeof value !== "string")
        return null;
    const sub = value.trim();
    if (!sub || sub.length > SUB_MAX || /\s/.test(sub))
        return null;
    if (/^0x[0-9a-fA-F]{40}$/.test(sub))
        return null;
    return sub;
}
function cleanIdp(value) {
    if (value === null || value === undefined || value === "")
        return null;
    if (typeof value === "string" && IDPS.includes(value)) {
        return value;
    }
    return "invalid";
}
function isRecord(value) {
    return !!value && typeof value === "object";
}
