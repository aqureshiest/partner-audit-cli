export interface OfficialRate {
    loanType: string;
    fixedLow: number;
    fixedHigh: number;
    variableLow: number;
    variableHigh: number;
}

interface RateRange {
    fixedLow: number;
    fixedHigh: number;
    variableLow: number;
    variableHigh: number;
}

// Safety-net values only used if the live rate API is unreachable — not authoritative.
const FALLBACK: Record<"SLR" | "SLR_HBG" | "SLO", RateRange> = {
    SLR: { fixedLow: 4.35, fixedHigh: 9.99, variableLow: 5.88, variableHigh: 9.99 },
    SLR_HBG: { fixedLow: 3.83, fixedHigh: 9.99, variableLow: 5.73, variableHigh: 9.99 },
    SLO: { fixedLow: 2.95, fixedHigh: 16.49, variableLow: 4.99, variableHigh: 16.85 },
};

interface HeadlineRatesResponse {
    rates: Array<{ rate_low: number; rate_high: number; rate_type: "fixed" | "variable" }>;
}

async function fetchRateRange(url: string): Promise<RateRange | null> {
    try {
        const json: HeadlineRatesResponse = await fetch(url).then((r) => r.json());
        const fixed = json.rates.find((r) => r.rate_type === "fixed");
        const variable = json.rates.find((r) => r.rate_type === "variable");
        if (!fixed || !variable) return null;
        return { fixedLow: fixed.rate_low, fixedHigh: fixed.rate_high, variableLow: variable.rate_low, variableHigh: variable.rate_high };
    } catch {
        return null;
    }
}

export async function loadOfficialRates(): Promise<OfficialRate[]> {
    const [slr, slrHbg, slo] = await Promise.all([
        fetchRateRange("https://connect.earnest.com/v1/headline_rates?product=slr"),
        fetchRateRange("https://connect.earnest.com/v1/headline_rates?product=slr&tag=high-balance-grads"),
        fetchRateRange("https://connect.earnest.com/v1/headline_rates?product=slo"),
    ]);

    if (!slr) console.warn("Could not fetch live SLR rates, using fallback values");
    if (!slrHbg) console.warn("Could not fetch live SLR (HBG) rates, using fallback values");
    if (!slo) console.warn("Could not fetch live SLO rates, using fallback values");

    return [
        { loanType: "SLR", ...(slr ?? FALLBACK.SLR) },
        { loanType: "SLR_HBG", ...(slrHbg ?? FALLBACK.SLR_HBG) },
        { loanType: "SLO", ...(slo ?? FALLBACK.SLO) },
    ];
}
