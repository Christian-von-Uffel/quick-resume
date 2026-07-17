import { normalizeStoredList } from "./resumeModel";

// Drop auditing for the prompt lab.
//
// Every production validator is a pure `map -> filter(Boolean) -> dedupe ->
// slice` that returns ONLY the survivors. That is right for the product — a
// question the person can't answer should never reach them — but it makes a
// prompt comparison lie: a challenger whose output the validator rejects looks
// exactly like a prompt that found nothing to say. In a lab those two are the
// opposite of the same thing, so the lab has to see the drops.
//
// Nothing here reimplements a validator's rules. A copy would drift from
// production the first time someone edited the real one, and every comparison
// the lab had ever drawn would quietly become wrong. Instead each raw item is
// fed through the REAL validator one item at a time: whatever the production
// predicate says about a single-item batch IS the answer. The batch call is
// then re-run to catch the cross-item effects — dedupe and the per-round cap —
// that a single-item probe cannot see by construction.
//
// This works only because the validators are pure, synchronous, and free of
// cross-item state apart from their dedupe Set. That holds today for all four
// (see the callers below); a validator that grew real cross-item logic would
// need its own audit.

// Ids assigned during a single-item probe are meaningless (every item comes
// back as "q-1-0" / "missing-0"), so probes are only ever used for counting and
// attribution — never for identity.
function survivesAlone(validate, wrap, item) {
  try {
    return validate(wrap([item])).length === 1;
  } catch {
    // A validator throws on a malformed BATCH, not a malformed item. Either way
    // this item did not survive, which is all the audit is asking.
    return false;
  }
}

function validateBatch(validate, wrap, items) {
  try {
    return validate(wrap(items));
  } catch {
    return [];
  }
}

/**
 * Run a raw model response through a production validator and report what it
 * dropped and why.
 *
 * @param validate    the real production validator, pre-bound to any extra args
 * @param wrap        items -> the argument shape the validator expects
 * @param rawList     the raw list from the model, before any validation
 * @param dedupeKeyOf item -> the key the validator dedupes on (mirrors its own
 *                    rule; only ever used to SPLIT a known drop count between
 *                    "duplicate" and "over the cap", never to drop anything)
 * @param cap         the validator's own item cap
 * @param diagnose    rejected item -> a short human reason, via re-probing
 */
export function auditValidation({
  validate,
  wrap,
  rawList,
  dedupeKeyOf = () => "",
  cap = Infinity,
  diagnose = () => "",
}) {
  const items = normalizeStoredList(rawList, []);
  const passed = [];
  const rejected = [];

  for (const item of items) {
    if (survivesAlone(validate, wrap, item)) passed.push(item);
    else rejected.push({ item, reason: diagnose(item) });
  }

  const kept = validateBatch(validate, wrap, items);

  const uniqueCount = new Set(passed.map(dedupeKeyOf)).size;
  const droppedDupe = passed.length - uniqueCount;
  const droppedCap = Math.max(0, uniqueCount - cap);

  return {
    rawCount: items.length,
    kept,
    keptCount: kept.length,
    droppedShape: items.length - passed.length,
    droppedDupe,
    droppedCap,
    rejected,
    // The audit's own arithmetic should land on what the validator actually
    // returned. When it doesn't, a validator has grown a rule this module can't
    // see, and the UI says so rather than quietly reporting numbers that no
    // longer add up.
    consistent: kept.length === Math.max(0, Math.min(uniqueCount, cap)),
  };
}

// A one-line summary of an audit, or "" when the validator kept everything.
export function describeDrops(audit) {
  if (!audit || audit.rawCount === 0) return "";
  const parts = [];
  if (audit.droppedShape) parts.push(`${audit.droppedShape} rejected`);
  if (audit.droppedDupe) parts.push(`${audit.droppedDupe} duplicate`);
  if (audit.droppedCap) parts.push(`${audit.droppedCap} over the cap`);
  if (!parts.length) return "";
  return `${audit.rawCount} returned, ${audit.keptCount} usable — ${parts.join(", ")}.`;
}
