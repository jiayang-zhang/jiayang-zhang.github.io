// Rules that discard documents with no chance of describing a Phase II/III
// outcome or a Phase III start, before any text is sent to a classifier.
// They are deliberately permissive: a false pass costs one classification,
// a false discard loses an event.

export type FilterResult = { pass: true } | { pass: false; reason: string };

// Form 8-K items under which companies furnish clinical press releases.
const DISCLOSURE_ITEMS = ["7.01", "8.01"];

const ROUTINE_6K = /director|pdmr|shareholding|voting rights|transaction in own shares|share (buy|repurchase)|buy-?back|dividend|general meeting|\bagm\b|block listing|admission to trading|holding\(s\) in company|directorate|notice of|annual report|total voting/i;

/** Uses only the metadata in EDGAR's filing list, so excluded filings are never downloaded. */
export function prefilterFilingMetadata(form: string, items: string, description: string): FilterResult {
  if (form.startsWith("8-K")) {
    const codes = items.split(",").map((s) => s.trim()).filter(Boolean);
    if (codes.length > 0 && !codes.some((c) => DISCLOSURE_ITEMS.includes(c))) {
      return { pass: false, reason: `8-K items ${codes.join(", ")} are not disclosure items` };
    }
    return { pass: true };
  }
  if (form.startsWith("6-K") && ROUTINE_6K.test(description)) return { pass: false, reason: `Routine 6-K: ${description.slice(0, 80)}` };
  return { pass: true };
}

const PHASE = /\bphase\s*(2|3|ii|iii)(\s*[ab])?\b|\bphase\s*(2|ii)\s*\/\s*(3|iii)\b|\bpivotal\b|\bregistrational\b/i;
const OUTCOME =
  /top-?line|primary end-?point|met (its|the|all|both)|did not meet|failed to (meet|achieve)|statistically significant|statistical significance|first (patient|participant|subject)s? ((has|have|was|were) (been )?)?(dosed|enrolled|treated|randomi[sz]ed)|(dosed|enrolled|treated|randomi[sz]ed) (the|its) first (patient|participant|subject)|initiat(e|ed|es|ion|ing)|commenc(e|ed|ement)|discontinu|terminat|futility|interim analysis|positive (results|data)|negative (results|data)/i;

/** A document must mention a Phase II/III trial and an outcome or start to be worth classifying. */
export function prefilterText(text: string): FilterResult {
  if (text.length < 200) return { pass: false, reason: "Document has no substantive text" };
  if (!PHASE.test(text)) return { pass: false, reason: "No Phase II or Phase III trial mentioned" };
  if (!OUTCOME.test(text)) return { pass: false, reason: "No trial outcome or initiation language" };
  return { pass: true };
}
