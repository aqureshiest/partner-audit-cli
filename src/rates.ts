export interface OfficialRate {
    loanType: string;
    fixedLow: number;
    fixedHigh: number;
    variableLow: number;
    variableHigh: number;
    /** From the live API, for citing "last updated" in partner emails. Null when fallback values were used. */
    rateMapVersion: string | null;
    effectiveDate: string | null;
}

interface RateRange {
    fixedLow: number;
    fixedHigh: number;
    variableLow: number;
    variableHigh: number;
    rateMapVersion: string | null;
    effectiveDate: string | null;
}

// Safety-net values only used if the live rate API is unreachable — not authoritative.
const FALLBACK: Record<"SLR" | "SLR_HBG" | "SLO" | "PL", RateRange> = {
    SLR: { fixedLow: 4.35, fixedHigh: 9.99, variableLow: 5.88, variableHigh: 9.99, rateMapVersion: null, effectiveDate: null },
    SLR_HBG: { fixedLow: 3.83, fixedHigh: 9.99, variableLow: 5.73, variableHigh: 9.99, rateMapVersion: null, effectiveDate: null },
    SLO: { fixedLow: 2.95, fixedHigh: 16.49, variableLow: 4.99, variableHigh: 16.85, rateMapVersion: null, effectiveDate: null },
    // PL is fixed-rate only (the API returns no "variable" entry) — variable mirrors fixed.
    PL: { fixedLow: 6.74, fixedHigh: 25.49, variableLow: 6.74, variableHigh: 25.49, rateMapVersion: null, effectiveDate: null },
};

interface HeadlineRatesResponse {
    rate_map_version: string;
    effective_date: string;
    rates: Array<{ rate_low: number; rate_high: number; rate_type: "fixed" | "variable" }>;
}

async function fetchRateRange(url: string): Promise<RateRange | null> {
    try {
        const json: HeadlineRatesResponse = await fetch(url).then((r) => r.json());
        const fixed = json.rates.find((r) => r.rate_type === "fixed");
        if (!fixed) return null;
        const variable = json.rates.find((r) => r.rate_type === "variable");
        return {
            fixedLow: fixed.rate_low,
            fixedHigh: fixed.rate_high,
            // Some products (e.g. PL) are fixed-rate only and have no "variable" entry.
            variableLow: variable?.rate_low ?? fixed.rate_low,
            variableHigh: variable?.rate_high ?? fixed.rate_high,
            rateMapVersion: json.rate_map_version ?? null,
            effectiveDate: json.effective_date ?? null,
        };
    } catch {
        return null;
    }
}

export async function loadOfficialRates(): Promise<OfficialRate[]> {
    const [slr, slrHbg, slo, pl] = await Promise.all([
        fetchRateRange("https://connect.earnest.com/v1/headline_rates?product=slr"),
        fetchRateRange("https://connect.earnest.com/v1/headline_rates?product=slr&tag=high-balance-grads"),
        fetchRateRange("https://connect.earnest.com/v1/headline_rates?product=slo"),
        fetchRateRange("https://connect.earnest.com/v1/headline_rates?product=pl"),
    ]);

    if (!slr) console.warn("Could not fetch live SLR rates, using fallback values");
    if (!slrHbg) console.warn("Could not fetch live SLR (HBG) rates, using fallback values");
    if (!slo) console.warn("Could not fetch live SLO rates, using fallback values");
    if (!pl) console.warn("Could not fetch live PL rates, using fallback values");

    return [
        { loanType: "SLR", ...(slr ?? FALLBACK.SLR) },
        { loanType: "SLR_HBG", ...(slrHbg ?? FALLBACK.SLR_HBG) },
        { loanType: "SLO", ...(slo ?? FALLBACK.SLO) },
        { loanType: "PL", ...(pl ?? FALLBACK.PL) },
    ];
}
