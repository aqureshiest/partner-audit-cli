import type { OfficialRate } from "./rates.js";

export interface CorrectionItem {
    example: string;
    link: string;
    correction: string;
}

function formatDate(isoDate: string | null): string {
    if (!isoDate) return "[Month Day, 20XX]";
    const d = new Date(isoDate);
    if (Number.isNaN(d.getTime())) return "[Month Day, 20XX]";
    return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export function buildEmailSubject(quarter: number, year: number): string {
    return `Action Required: Earnest Q${quarter} ${year} Compliance Audit`;
}

export function buildEmailBody(params: {
    quarter: number;
    year: number;
    slrRate: OfficialRate;
    sloRate: OfficialRate;
    corrections: CorrectionItem[];
    respondByDate: string;
}): string {
    const { quarter, year, slrRate, sloRate, corrections, respondByDate } = params;

    const correctionsBlock = corrections
        .map((item) => `Example: ${item.example}\nLink: ${item.link}\nCorrection: ${item.correction}`)
        .join("\n\n");

    return `Dear Partner,

We're writing to inform you that the Q${quarter} ${year} compliance audit has been successfully completed. The objective of this audit was to validate that all fixed and variable rates, loan cost examples, disclosures, and other information, such as eligibility requirements, published on your partner site for both SLO (Student Loan Originations) and SLR (Student Loan Refinance) products are accurate. We also conducted a thorough verification to ensure no Unfair, Deceptive, or Abusive Acts or Practices (UDAAP) issues were present.

Audit Scope and Verification Details

For the SLO product, verification was performed against SLO Rate Map ${sloRate.rateMapVersion ?? "[XXX]"}, last updated on ${formatDate(sloRate.effectiveDate)}. This map specified fixed rates ranging from ${sloRate.fixedLow}% to ${sloRate.fixedHigh}% and variable rates ranging from ${sloRate.variableLow}% to ${sloRate.variableHigh}% (including a 0.25% autopay discount).

Please note that SLO Graduate, International, and Halftime Student rates were not included in the scope of this audit.

For the SLR product, verification was performed using SLR Rate Map ${slrRate.rateMapVersion ?? "[XXX]"}, updated on ${formatDate(slrRate.effectiveDate)}. This map indicated the following rates:

- Fixed: ${slrRate.fixedLow}% - ${slrRate.fixedHigh}%
- Variable: ${slrRate.variableLow}% - ${slrRate.variableHigh}% (including a 0.25% autopay discount)

Corrections Required

During this audit, the following corrections required were noted on your partner site:

${correctionsBlock}

We ask that you confirm receipt and provide an update with these corrections by ${respondByDate}. We will be in touch to follow up on remediation and if you have any immediate questions, please don't hesitate to reach out.

Thank you for your continued partnership.

[Signature]`;
}
