import { readFileSync, writeFileSync, existsSync } from "fs";
import type { UrlResult } from "./analyze.js";

export type RunKind = "quarterly" | "rate-map";

export interface HistoryPage {
    urlKey: string;
    partnerName: string;
    status: string;
    highCount: number;
    medCount: number;
}

export interface HistoryPartner {
    name: string;
    pageCount: number;
    overallStatus: string;
    urgency: string;
    highCount: number;
    medCount: number;
}

export interface HistoryRecord {
    date: string;
    kind: RunKind;
    usableAsBaseline: boolean;
    pages: HistoryPage[];
    partners: HistoryPartner[];
}

// --- Identity matching across runs (partner names change between runs; URLs don't) ---

export function normalizeUrl(url: string): string {
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, "");
        const path = u.pathname.replace(/\/$/, "");
        return `${host}${path}`;
    } catch {
        return url.trim();
    }
}

const GENERIC_WORDS = /\b(the|llc|inc|ltd|co|corp|company|financial)\b/g;

export function normalizeName(name: string): string {
    return name
        .toLowerCase()
        .replace(/\[[^\]]*\]/g, "")
        .replace(/&/g, "and")
        .replace(GENERIC_WORDS, "")
        .replace(/[^a-z0-9]/g, "");
}

function bigrams(s: string): Map<string, number> {
    const map = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
        const bg = s.slice(i, i + 2);
        map.set(bg, (map.get(bg) ?? 0) + 1);
    }
    return map;
}

export function diceCoefficient(a: string, b: string): number {
    if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
    const ba = bigrams(a);
    const bb = bigrams(b);
    let intersection = 0;
    for (const [bg, count] of ba) {
        const other = bb.get(bg);
        if (other) intersection += Math.min(count, other);
    }
    const totalA = [...ba.values()].reduce((s, c) => s + c, 0);
    const totalB = [...bb.values()].reduce((s, c) => s + c, 0);
    return (2 * intersection) / (totalA + totalB);
}

const NAME_MATCH_THRESHOLD = 0.85;

/**
 * Maps each current partner name to its best-guess identity in the baseline run.
 * Priority: (1) shared URL with a baseline page — resolves renames without any
 * name similarity needed; (2) fuzzy name match above threshold; (3) unmatched (new partner).
 */
export function matchPartnersToBaseline(
    currentPages: HistoryPage[],
    baseline: HistoryRecord,
): Map<string, string | null> {
    const baselineUrlToPartner = new Map(baseline.pages.map((p) => [p.urlKey, p.partnerName]));
    const currentPartnerNames = [...new Set(currentPages.map((p) => p.partnerName))];

    const result = new Map<string, string | null>();
    for (const name of currentPartnerNames) {
        const urlsForPartner = currentPages.filter((p) => p.partnerName === name).map((p) => p.urlKey);
        const matchedViaUrl = urlsForPartner
            .map((u) => baselineUrlToPartner.get(u))
            .find((m): m is string => m !== undefined);
        if (matchedViaUrl) {
            result.set(name, matchedViaUrl);
            continue;
        }

        const normalizedCurrent = normalizeName(name);
        let best: { name: string; score: number } | null = null;
        for (const bp of baseline.partners) {
            const score = diceCoefficient(normalizedCurrent, normalizeName(bp.name));
            if (score >= NAME_MATCH_THRESHOLD && (!best || score > best.score)) best = { name: bp.name, score };
        }
        result.set(name, best?.name ?? null);
    }
    return result;
}

// --- Building & persisting history records ---

function countByPrefix(violations: string[], prefix: string): number {
    return violations.filter((v) => v.startsWith(prefix)).length;
}

export function buildHistoryRecord(date: string, kind: RunKind, results: UrlResult[]): HistoryRecord {
    const pages: HistoryPage[] = results.map((r) => ({
        urlKey: normalizeUrl(r.url),
        partnerName: r.partnerName,
        status: r.status,
        highCount: countByPrefix(r.violations, "HIGH"),
        medCount: countByPrefix(r.violations, "MEDIUM"),
    }));

    const byPartner = new Map<string, HistoryPage[]>();
    for (const p of pages) byPartner.set(p.partnerName, [...(byPartner.get(p.partnerName) ?? []), p]);

    const partners: HistoryPartner[] = [...byPartner.entries()].map(([name, pagesForPartner]) => {
        const hasViolations = pagesForPartner.some((p) => p.status === "violations");
        const hasWarnings = pagesForPartner.some((p) => p.status === "warnings");
        const overallStatus = hasViolations ? "violations" : hasWarnings ? "warnings" : "compliant";
        const urgency = hasViolations ? "high" : hasWarnings ? "medium" : "low";
        return {
            name,
            pageCount: pagesForPartner.length,
            overallStatus,
            urgency,
            highCount: pagesForPartner.reduce((s, p) => s + p.highCount, 0),
            medCount: pagesForPartner.reduce((s, p) => s + p.medCount, 0),
        };
    });

    const notAnalyzed = results.filter((r) => r.status === "blocked" || r.status === "error").length;
    const usableAsBaseline = results.length > 0 && notAnalyzed / results.length <= 0.2;

    return { date, kind, usableAsBaseline, pages, partners };
}

const DEFAULT_HISTORY_PATH = "audit-history.json";

export function loadHistory(path: string = DEFAULT_HISTORY_PATH): HistoryRecord[] {
    if (!existsSync(path)) return [];
    try {
        const parsed = JSON.parse(readFileSync(path, "utf-8"));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function upsertHistory(history: HistoryRecord[], record: HistoryRecord): HistoryRecord[] {
    const withoutSameDate = history.filter((h) => h.date !== record.date);
    return [...withoutSameDate, record].sort((a, b) => a.date.localeCompare(b.date));
}

export function saveHistory(history: HistoryRecord[], path: string = DEFAULT_HISTORY_PATH): void {
    writeFileSync(path, JSON.stringify(history, null, 2));
}

export function pickBaseline(history: HistoryRecord[], currentDate: string, currentKind: RunKind): HistoryRecord | null {
    const candidates = history
        .filter((h) => h.date !== currentDate && h.usableAsBaseline && h.kind === currentKind)
        .sort((a, b) => b.date.localeCompare(a.date));
    return candidates[0] ?? null;
}

// --- Trend computation (matched-intersection only, never raw run totals) ---

export interface PageTrend {
    matchedCount: number;
    improved: number;
    regressed: number;
    unchanged: number;
    currentHighSum: number;
    baselineHighSum: number;
    currentCompliantCount: number;
    baselineCompliantCount: number;
    currentNotAnalyzedCount: number;
    baselineNotAnalyzedCount: number;
}

export function computePageTrend(currentPages: HistoryPage[], baseline: HistoryRecord): PageTrend {
    const baselineByUrl = new Map(baseline.pages.map((p) => [p.urlKey, p]));
    const matched = currentPages
        .map((p) => ({ current: p, prior: baselineByUrl.get(p.urlKey) }))
        .filter((m): m is { current: HistoryPage; prior: HistoryPage } => m.prior !== undefined);

    let improved = 0, regressed = 0, unchanged = 0;
    let currentHighSum = 0, baselineHighSum = 0;
    let currentCompliantCount = 0, baselineCompliantCount = 0;
    let currentNotAnalyzedCount = 0, baselineNotAnalyzedCount = 0;

    for (const { current, prior } of matched) {
        // Improved/regressed/unchanged is based on high-risk violation count moving
        // down/up/staying flat — not overall status or total (high+medium) flag count.
        if (current.highCount < prior.highCount) improved++;
        else if (current.highCount > prior.highCount) regressed++;
        else unchanged++;

        currentHighSum += current.highCount;
        baselineHighSum += prior.highCount;
        if (current.status === "compliant") currentCompliantCount++;
        if (prior.status === "compliant") baselineCompliantCount++;
        if (current.status === "blocked" || current.status === "error") currentNotAnalyzedCount++;
        if (prior.status === "blocked" || prior.status === "error") baselineNotAnalyzedCount++;
    }

    return {
        matchedCount: matched.length,
        improved, regressed, unchanged,
        currentHighSum, baselineHighSum,
        currentCompliantCount, baselineCompliantCount,
        currentNotAnalyzedCount, baselineNotAnalyzedCount,
    };
}

export interface PartnerTrend {
    matchedPartnerCount: number;
    currentCompliantCount: number;
    baselineCompliantCount: number;
    currentWithHighRiskCount: number;
    baselineWithHighRiskCount: number;
    /** Per current-partner-name delta in high-risk count vs. its matched baseline identity (null = no match found). */
    highCountDeltaByPartner: Map<string, number | null>;
}

export function computePartnerTrend(
    currentPartners: HistoryPartner[],
    currentPages: HistoryPage[],
    baseline: HistoryRecord,
): PartnerTrend {
    const identityMap = matchPartnersToBaseline(currentPages, baseline);
    const baselineByName = new Map(baseline.partners.map((p) => [p.name, p]));

    let matchedPartnerCount = 0;
    let currentCompliantCount = 0, baselineCompliantCount = 0;
    let currentWithHighRiskCount = 0, baselineWithHighRiskCount = 0;
    const highCountDeltaByPartner = new Map<string, number | null>();

    for (const cp of currentPartners) {
        const baselineName = identityMap.get(cp.name);
        const bp = baselineName ? baselineByName.get(baselineName) : undefined;
        if (!bp) {
            highCountDeltaByPartner.set(cp.name, null);
            continue;
        }
        matchedPartnerCount++;
        if (cp.overallStatus === "compliant") currentCompliantCount++;
        if (bp.overallStatus === "compliant") baselineCompliantCount++;
        if (cp.highCount > 0) currentWithHighRiskCount++;
        if (bp.highCount > 0) baselineWithHighRiskCount++;
        highCountDeltaByPartner.set(cp.name, cp.highCount - bp.highCount);
    }

    return {
        matchedPartnerCount,
        currentCompliantCount, baselineCompliantCount,
        currentWithHighRiskCount, baselineWithHighRiskCount,
        highCountDeltaByPartner,
    };
}
