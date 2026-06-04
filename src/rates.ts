export interface OfficialRate {
    loanType: string;
    fixedLow: number;
    fixedHigh: number;
    variableLow: number;
    variableHigh: number;
}

const FALLBACK: OfficialRate[] = [
    { loanType: "SLR", fixedLow: 4.35, fixedHigh: 9.99, variableLow: 5.88, variableHigh: 9.99 },
    { loanType: "SLO", fixedLow: 2.95, fixedHigh: 16.49, variableLow: 4.99, variableHigh: 16.85 },
];

export async function loadOfficialRates(): Promise<OfficialRate[]> {
    try {
        const [slr, slo] = await Promise.all([
            fetch("https://connect.earnest.com/v1/headline_rates?product=slr").then((r) => r.json()),
            fetch("https://connect.earnest.com/v1/headline_rates?product=slo").then((r) => r.json()),
        ]);

        return [
            {
                loanType: "SLR",
                fixedLow: slr.fixed_low ?? FALLBACK[0].fixedLow,
                fixedHigh: slr.fixed_high ?? FALLBACK[0].fixedHigh,
                variableLow: slr.variable_low ?? FALLBACK[0].variableLow,
                variableHigh: slr.variable_high ?? FALLBACK[0].variableHigh,
            },
            {
                loanType: "SLO",
                fixedLow: slo.fixed_low ?? FALLBACK[1].fixedLow,
                fixedHigh: slo.fixed_high ?? FALLBACK[1].fixedHigh,
                variableLow: slo.variable_low ?? FALLBACK[1].variableLow,
                variableHigh: slo.variable_high ?? FALLBACK[1].variableHigh,
            },
        ];
    } catch {
        console.warn("Failed to fetch official rates, using fallback values");
        return FALLBACK;
    }
}
