import type { OfficialRate } from "./rates.js";

export interface CorrectionExample {
    example: string;
    correction: string;
}

export interface LinkGroup {
    link: string;
    examples: CorrectionExample[];
}

const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

// Reads the date in UTC, not the local timezone — the rate API's effective_date is a
// label for "which calendar day", not a local-time event, so converting to local time
// can shift it to the wrong day (e.g. a UTC midnight timestamp reads as the prior day
// in any timezone behind UTC).
function formatDate(isoDate: string | null): string {
    if (!isoDate) return "[Month Day, 20XX]";
    const d = new Date(isoDate);
    if (Number.isNaN(d.getTime())) return "[Month Day, 20XX]";
    return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Converts plain text with \n line breaks into HTML, escaping first so user-supplied
 * text (corrections, findings) can't inject markup. */
function textToHtml(s: string): string {
    return escapeHtml(s).replace(/\n/g, "<br>");
}

export function buildEmailSubject(quarter: number, year: number): string {
    return `Action Required: Earnest Q${quarter} ${year} Compliance Audit`;
}

/**
 * Returns an HTML body matching the team's standard template and real-world examples:
 * bold "Q# YYYY compliance audit" phrase, bold section headers, bold+underlined
 * "Link #N:"/"Example #N:" labels (Example numbering restarts at 1 per Link),
 * underlined (not bold) "Correction:" label, and a bold closing deadline sentence.
 * SLO is not mentioned — this workflow only ever covers SLR.
 */
export function buildEmailBody(params: {
    quarter: number;
    year: number;
    slrRate: OfficialRate;
    corrections: LinkGroup[];
    respondByDate: string;
}): string {
    const { quarter, year, slrRate, corrections, respondByDate } = params;

    const correctionsBlock = corrections
        .map((group, linkIndex) => {
            const linkLine = `<b><u>Link #${linkIndex + 1}:</u></b> ${textToHtml(group.link)}`;
            const exampleLines = group.examples
                .map((ex, exampleIndex) =>
                    `<b><u>Example #${exampleIndex + 1}:</u></b> ${textToHtml(ex.example)}<br><u>Correction:</u> ${textToHtml(ex.correction)}`,
                )
                .join("<br><br>");
            return `${linkLine}<br>${exampleLines}`;
        })
        .join("<br><br>");

    return `<p>Dear Partner,</p>

<p>We're writing to inform you that the <b>Q${quarter} ${year} compliance audit</b> has been successfully completed. The objective of this audit was to validate that all fixed and variable rates, loan cost examples, disclosures, and other information, such as eligibility requirements, published on your partner site for the SLR (Student Loan Refinance) product are accurate. We also conducted a thorough verification to ensure no Unfair, Deceptive, or Abusive Acts or Practices (UDAAP) issues were present.</p>

<p><b>Audit Scope and Verification Details</b></p>

<p>For the SLR product, verification was performed using SLR Rate Map ${escapeHtml(slrRate.rateMapVersion ?? "[XXX]")}, updated on ${formatDate(slrRate.effectiveDate)}. This map indicated the following rates:</p>

<p>- Fixed: ${slrRate.fixedLow}% - ${slrRate.fixedHigh}%<br>- Variable: ${slrRate.variableLow}% - ${slrRate.variableHigh}%</p>

<p><b>Corrections Required</b></p>

<p>During this audit, the following corrections were noted on your partner site:</p>

<p>${correctionsBlock}</p>

<p><b>We ask that you confirm receipt and provide an update with these corrections by ${escapeHtml(respondByDate)}.</b> We will be in touch to follow up on remediation and if you have any immediate questions, please don't hesitate to reach out.</p>

<p>Thank you for your continued partnership.</p>

<p>[Signature]</p>`;
}
