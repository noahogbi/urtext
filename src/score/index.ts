import {
  ANONYMOUS_OWNER,
  GETTER_FRAME_PREFIX,
  LOCAL_SCOPE,
  MODULE_OWNER,
  SETTER_FRAME_PREFIX,
} from "../extract/scope.js";
import { SIGNATURE_TRUNCATION_MARKER } from "../analyze/surface.js";
import type { Claim, EffectKind, Fact, Finding, Tier } from "../types.js";
import {
  typeUnresolvedNoteFor,
  foldReach,
  groupAddedExports,
  groupSignatureChanges,
  reachKey,
  type SignatureChangeDetail,
} from "./reach.js";

/**
 * Tunable in one place on purpose: these weights will need adjusting once
 * they have been run against real diffs.
 */
export const WEIGHTS = {
  factKind: {
    // A vanished check is the best mechanical proxy for a correctness or
    // security regression, so it outranks everything else.
    guard_removed: 90,
    signature_changed: 75,
    export_removed: 70,
    effect_added: 60,
    // Deliberately far below the ceiling the log curve is clamped to (see
    // `effect_added`, above): this is the *base* the log-scaled formula in
    // `scoreFact` multiplies, not the score a blast-radius fact typically
    // gets. At a base of 40 the curve saturated at three references, so 4
    // references and 24 scored identically and every blast-radius finding
    // in a real run tied at the ceiling and sorted by file path — the
    // ranking carried no information at all. The base was lowered to the
    // value below so the curve instead spans one reference up to the
    // ceiling at roughly a thousand, which covers every count a real
    // repository produces. See `scoreFact`.
    blast_radius: 15,
    export_added: 25,
    effect_removed: 15,
    // A rotted citation is a defect in the repository's account of itself, not
    // in its behavior: nothing a reader merges is broken by it. So it sits
    // above the kinds that report cost rather than a problem, and below the
    // kinds that report new public surface or a regression. See
    // `test/score/index.test.ts`.
    citation_rot: 18,
  } satisfies Record<Fact["kind"], number>,
  effect: {
    network: 1.0,
    database: 1.0,
    process: 0.9,
    filesystem: 0.8,
    env: 0.6,
    timing: 0.4,
  } satisfies Record<EffectKind, number>,
};

function effectOf(fact: Fact): EffectKind {
  const e = fact.detail.effect;
  return typeof e === "string" && Object.hasOwn(WEIGHTS.effect, e)
    ? (e as EffectKind)
    : "timing";
}

export function scoreFact(fact: Fact): number {
  const base = WEIGHTS.factKind[fact.kind];

  if (fact.kind === "effect_added" || fact.kind === "effect_removed") {
    return base * WEIGHTS.effect[effectOf(fact)];
  }

  if (fact.kind === "blast_radius") {
    // Log-scaled: three callers and forty are meaningfully different, forty
    // and eighty are not. The base must stay low enough that the curve does
    // not hit the ceiling below the reference counts real repositories
    // produce — a saturated curve ranks nothing (see `WEIGHTS.factKind.blast_radius`).
    const refs = typeof fact.detail.references === "number" ? fact.detail.references : 1;
    const logScaled = base * (1 + Math.log10(Math.max(refs, 1)));
    // A blast-radius fact reports reach, not a defect: "this changed and a
    // lot of code uses it" names no problem by itself, so no reference count
    // may push it above a fact that does. `effect_added` is a deliberately
    // chosen ceiling, set below guard_removed / signature_changed /
    // export_removed — the kinds that most directly report a regression —
    // so a widely-used export can never bury one of those under sheer reach.
    // Do not raise this to "fix" a large-repo score; raise it only by
    // deciding blast radius should outrank a removed guard, which it should
    // not.
    return Math.min(logScaled, WEIGHTS.factKind.effect_added);
  }

  return base;
}

const FACT_KINDS = Object.keys(WEIGHTS.factKind) as Fact["kind"][];
const EFFECT_KINDS = Object.keys(WEIGHTS.effect) as EffectKind[];

function syntheticFact(kind: Fact["kind"], detail: Record<string, unknown>): Fact {
  return { id: "synthetic", kind, file: "synthetic.ts", line: 1, detail, evidence: [] };
}

/**
 * The lowest score any real analyzer fact can produce, across every fact
 * kind and — for the two effect kinds, whose score also depends on which
 * effect fired — every effect. Computed by actually calling `scoreFact` on
 * a synthetic fact of each shape, not by reading `WEIGHTS.factKind` and
 * taking its minimum directly: that minimum (shared by `blast_radius` and
 * `effect_removed`) is a real, producible score — `effect_removed` ×
 * `network` or `database` reaches it exactly, and so does `blast_radius` at
 * one reference — but it is not the *lowest* producible score. `scoreFact`
 * also multiplies `effect_removed`'s (and `effect_added`'s) base by an
 * effect weight that can sit below `network`/`database`'s (`timing` is the
 * lowest), which takes `effect_removed` down further still — a score
 * `WEIGHTS.factKind` has no entry for,
 * because it only lists each kind's base, not what the formula built on top
 * of that base can still produce. Calling `scoreFact` directly means this
 * tracks the real formula (the effect multiplier, the blast_radius log
 * curve) instead of a hand-copied table that cannot see below its own
 * bases. `reconcile.ts` derives `MODEL_CEILING` from this, so a claim can
 * never be scored above the weakest thing an analyzer can find.
 */
export function minPossibleAnalyzerScore(): number {
  const scores = FACT_KINDS.flatMap((kind) => {
    if (kind === "effect_added" || kind === "effect_removed") {
      return EFFECT_KINDS.map((effect) => scoreFact(syntheticFact(kind, { effect, sites: 1 })));
    }
    if (kind === "blast_radius") {
      // references: one is the floor — the analyzer that emits blast_radius
      // facts never emits one for zero references (see the early return in
      // src/analyze/blast-radius.ts, `if (refs.length === 0) continue;`),
      // so nothing weaker exists.
      return [scoreFact(syntheticFact(kind, { references: 1 }))];
    }
    return [scoreFact(syntheticFact(kind, {}))];
  });
  return Math.min(...scores);
}

/**
 * The evidence tier for a finding, from what produced it.
 *
 * - `verified` — an analyzer found it and can point at the code.
 * - `inferred` — the model explained something an analyzer found. The fact
 *   is still true; the *explanation* is the model's, so the finding is only
 *   as good as that explanation.
 * - `model` — the model alone. Nothing mechanical corroborates it.
 *
 * A fact always beats a claim: if there is a fact, the tier can never be
 * `model`, because something machine-checked is underneath it.
 */
export function tierFor(fact: Fact | undefined, claim: Claim | undefined): Tier {
  if (fact && claim?.correspondsTo === fact.id) return "inferred";
  if (fact) return "verified";
  return "model";
}

/** "a network" but "an env" — the first words a user reads. */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" ? v : fallback;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Longest signature text, in code points, that a finding body renders
 * verbatim on either side of a was→now sentence. Deliberately far below
 * `MAX_SIGNATURE_LENGTH` (the storage cap in `../analyze/surface.ts`): that
 * one bounds what a fact *carries*, this one bounds what a sentence *shows*.
 * The first dogfood run printed a JWT-sized string literal verbatim into a
 * body, which both drowned the sentence and republished a secret-looking
 * literal in a report — the middle-truncated rendering is readability plus
 * soft redaction. Nothing is hidden from a reader who wants the full text:
 * it remains in the diff itself, at the declaration every such finding
 * anchors its evidence to. `test/comment-contract.test.ts` derives part of
 * its forbidden set from this, so comments name it rather than restating
 * its value.
 */
export const MAX_RENDERED_SIGNATURE = 120;

/**
 * How much of the tail survives the middle cut. A tail is kept at all —
 * rather than cutting at the end the way `truncateSignature` in
 * `../analyze/surface.ts` does — because the end of a signature is often
 * the discriminating part (a return type, a literal's final characters),
 * and a head-only cut of two long literals sharing a prefix would render
 * identically.
 */
const RENDERED_SIGNATURE_TAIL = 12;

/**
 * Middle-truncates a signature that would overflow `MAX_RENDERED_SIGNATURE`,
 * stating the original length so the cut is visible rather than mistakable
 * for the whole text. Counted and cut by code point, not UTF-16 unit, for
 * the same reason `excerpt` in `../report/terminal.ts` is: `String#slice`
 * counts units, so an astral character straddling either cut would leave a
 * lone surrogate that renders as U+FFFD. Applied here, in the one place
 * was→now sentences are composed, so the terminal and HTML renderers cannot
 * disagree about what they show.
 *
 * `trueChars` is the length stated in the marker when given: the length of
 * the signature before any upstream cap cut it, not of whatever text
 * survived to this layer — a marker measuring the surviving text asserted
 * a false size whenever the storage cap had already run.
 */
function truncateRenderedSignature(text: string, trueChars?: number): string {
  const points = [...text];
  if (points.length <= MAX_RENDERED_SIGNATURE) return text;
  const head = points.slice(0, MAX_RENDERED_SIGNATURE - RENDERED_SIGNATURE_TAIL - 1).join("");
  const tail = points.slice(points.length - RENDERED_SIGNATURE_TAIL).join("");
  return `${head}…${tail} (${trueChars ?? points.length} chars)`;
}

/**
 * One side of a was→now sentence, from what the fact stored. `trueChars`
 * is the fact's `beforeChars`/`afterChars` detail — the code-point length
 * the surface analyzer measured before `MAX_SIGNATURE_LENGTH` capped the
 * stored text. When it is present, a trailing storage marker is dropped
 * ahead of the middle cut: the render marker states the true length now,
 * and keeping both left the storage marker's tail fragment sitting inside
 * the rendered tail. When it is absent — an older fact, or one built by
 * hand — the stored text renders exactly as before, marker included, with
 * the marker length falling back to the stored text's own count.
 */
function renderStoredSignature(stored: string, trueChars: unknown): string {
  const chars = typeof trueChars === "number" ? trueChars : undefined;
  const bare =
    chars === undefined ? stored : stored.replace(SIGNATURE_TRUNCATION_MARKER, "");
  return truncateRenderedSignature(bare, chars);
}

/**
 * The signature_changed prose, shared between `toFinding` (one fact, one
 * finding) and the member details `rankWithAbsorption` hands to
 * `groupSignatureChanges` — composed once so the grouped and ungrouped
 * renderings of the same fact cannot drift apart.
 *
 * On narrowing: `hasName` (an aliased condition, a stored boolean) carries
 * a type-guard's narrowing only for a const variable, not for a property
 * access — narrowing `fact.detail.export` through it would not compile —
 * and the local is reused for `leadingName`, which capitalises only the
 * fallback so a real export keeps its own casing (see `capitalize`'s doc
 * comment).
 */
function describeSignatureChange(fact: Fact): {
  name: string;
  sentence: string;
  typeUnresolved: boolean;
} {
  const rawName = fact.detail.export;
  const hasName = isNonEmptyString(rawName);
  const name = hasName ? rawName : "an export";
  const rawBefore = str(fact.detail.before, "its previous type");
  const rawAfter = str(fact.detail.after, "a new type");
  // Detected on the raw strings, ahead of truncation — though `any` is
  // short enough that the order could never matter — and asymmetric on
  // purpose: an export that was already `any` and stayed `any` never
  // emits a fact, and one whose *before* side reads `any` genuinely
  // narrowed, which needs no hedge. The hedge itself is
  // `typeUnresolvedNoteFor`, whose doc comment (in `./reach.js`) argues why
  // it keys on the rendered text.
  const typeUnresolved = rawAfter === "any" && rawBefore !== "any";
  const leadingName = hasName ? name : capitalize(name);
  const sentence = `${leadingName} was ${renderStoredSignature(rawBefore, fact.detail.beforeChars)} and is now ${renderStoredSignature(rawAfter, fact.detail.afterChars)}.`;
  return { name, sentence, typeUnresolved };
}

/**
 * Bodies are sentences and must start capitalised — unlike titles, which are
 * deliberately lowercase-led because the renderer prefixes them with
 * `file:line — `. Only ever applied to a fallback string (see call sites): a
 * real symbol name keeps whatever casing the source code gave it, since
 * forcing that would misspell the identifier the user is reading about.
 */
function capitalize(s: string): string {
  return s.length > 0 ? `${s[0].toUpperCase()}${s.slice(1)}` : s;
}

/**
 * Plain English for every scope sentinel a qualified owner path can contain,
 * keyed on the constants themselves. `guardOwnerLabel` translates what is in
 * this table plus the accessor frames (`accessorSegmentLabel`, below) and
 * nothing else, so a sentinel is either listed here or printed raw to a
 * reader. `SCOPE_SENTINELS` is the list this has to cover, and
 * `test/score/index.test.ts` walks that list rather than this table — so a new
 * sentinel with no entry here fails a test instead of reaching a report.
 */
const SEGMENT_LABEL: Record<string, string> = {
  [MODULE_OWNER]: "the top level of this file",
  [ANONYMOUS_OWNER]: "an anonymous function",
  [LOCAL_SCOPE]: "an unnamed block",
};

/**
 * "the value getter" for an accessor's `get value` frame — the second family
 * of path segments that is not source text a reader can search for, beside
 * the sentinels above. Parameterised where the sentinels are fixed, so it is
 * a function rather than more table rows; `test/score/index.test.ts` pins
 * both accessor kinds at every path position the sentinel walk covers.
 */
function accessorSegmentLabel(segment: string): string | undefined {
  if (segment.startsWith(GETTER_FRAME_PREFIX)) {
    return `the ${segment.slice(GETTER_FRAME_PREFIX.length)} getter`;
  }
  if (segment.startsWith(SETTER_FRAME_PREFIX)) {
    return `the ${segment.slice(SETTER_FRAME_PREFIX.length)} setter`;
  }
  return undefined;
}

/**
 * `guard_removed`'s `symbol` is the qualified owner path `collectGuards`
 * attributed the guard to — `Worker.run`, which reads fine as it stands. What
 * does not read fine are the sentinels that path can contain.
 *
 * A sentinel can sit at *any* position, and handling only "the whole path" and
 * "the last segment" printed a raw one to the reader — `<anonymous>.inner` for a
 * method of an object literal passed straight to a call, `<local>.run` for an
 * arrow declared in a top-level block, `Registry.<local>.helper` for a local in
 * a static initializer block. So the path is read as segments: each run of
 * real names stays dotted, each sentinel becomes its phrase, and the pieces are
 * joined innermost first — "inner in an anonymous function", "an anonymous
 * function in Worker.run", "run in an unnamed block". A path of real names comes
 * back exactly as it went in, and a lone `MODULE_OWNER` comes back as the one
 * phrase it has always had.
 */
function guardOwnerLabel(v: unknown): string {
  const s = str(v, "this code");
  const parts: string[] = [];
  let named: string[] = [];
  const flush = () => {
    if (named.length > 0) parts.push(named.join("."));
    named = [];
  };
  for (const segment of s.split(".")) {
    const label = SEGMENT_LABEL[segment] ?? accessorSegmentLabel(segment);
    if (label) {
      flush();
      parts.push(label);
    } else {
      named.push(segment);
    }
  }
  flush();
  return parts.reverse().join(" in ");
}

export function toFinding(fact: Fact): Finding {
  let title: string;
  let body: string;

  switch (fact.kind) {
    case "effect_added":
    case "effect_removed": {
      // No file path here: the renderer prefixes every finding with
      // `file:line — `, and the JSON carries `file` as its own field. Naming
      // it again produced "svc.ts:2 — svc.ts introduces a network effect".
      const effect = effectOf(fact);
      const sites = num(fact.detail.sites, 1);
      const an = article(effect);
      const where = sites === 1 ? "at one site" : `at ${sites} sites`;
      title =
        fact.kind === "effect_added"
          ? `introduces ${an} ${effect} effect`
          : `no longer has ${an} ${effect} effect`;
      body =
        fact.kind === "effect_added"
          ? `This file previously had no ${effect} effect. It now does, ${where}.`
          : `This file previously had ${an} ${effect} effect ${where}. It no longer does.`;
      break;
    }
    case "guard_removed": {
      const owner = guardOwnerLabel(fact.detail.symbol);
      const guard = str(fact.detail.guard, "check");
      const an = article(guard);
      title = `${an} ${guard} guard was removed from ${owner}`;
      body = `${an[0].toUpperCase()}${an.slice(1)} ${guard} guard that previously ran in ${owner} is no longer present. Removed checks are where correctness and security regressions usually hide, so confirm the condition is genuinely unreachable now.`;
      break;
    }
    case "export_added": {
      const name = str(fact.detail.export, "an export");
      title = `${name} is newly exported`;
      body = `This file did not export ${name} before.`;
      break;
    }
    case "export_removed": {
      const name = str(fact.detail.export, "an export");
      title = `${name} is no longer exported`;
      body = `This file previously exported ${name}. Anything importing it will fail to resolve.`;
      break;
    }
    case "signature_changed": {
      const d = describeSignatureChange(fact);
      title = `${d.name} changed its signature`;
      body = `${d.sentence}${d.typeUnresolved ? ` ${typeUnresolvedNoteFor([d.name])}` : ""}`;
      break;
    }
    case "blast_radius": {
      const rawSymbol = fact.detail.symbol;
      const hasSymbol = isNonEmptyString(rawSymbol);
      const symbol = hasSymbol ? rawSymbol : "this export";
      const refs = num(fact.detail.references, 0);
      const places = refs === 1 ? "one place" : `${refs} places`;
      const verb = refs === 1 ? "references" : "reference";
      title = `${symbol} changed and is referenced in ${places}`;
      const leadingSymbol = hasSymbol ? symbol : capitalize(symbol);
      body = `${leadingSymbol} was modified, and ${places} in this repository ${verb} it.`;
      break;
    }
    case "citation_rot": {
      const cited = str(fact.detail.citedFile, "the cited file");
      const start = num(fact.detail.citedLine, 0);
      const end = num(fact.detail.citedEndLine, 0);
      // The citation as the prose wrote it: a line, a range, or — for the
      // quoted form — no line at all.
      const at = start === 0 ? "" : end === 0 ? `:${start}` : `:${start}-${end}`;
      // True only when the citation reaches more than one line. A citation
      // the prose wrote as a degenerate range — `X:2-2` — stays a range in
      // the title, which echoes what was written, and is one line everywhere
      // a sentence has to agree with it.
      const spanned = end !== 0 && end !== start;
      const hash = fact.detail.baseline;
      const dated = isNonEmptyString(hash);
      const when = dated ? `when this line was last written (${hash})` : "";
      // Only `missing_file` has a branch for the undated case, and that is
      // not an oversight: the analyzer runs the other three tests solely
      // against a baseline file it has already read, so a fact of those
      // kinds carrying no commit cannot be produced. See
      // `src/analyze/citations.ts`, "With no baseline — blame failed, or the
      // historical-read budget is spent — only the first test runs, ungated,
      // against the reviewed revision."
      switch (fact.detail.rot) {
        case "missing_file":
          if (!dated) {
            // No baseline means no commit to name and no proof the path was
            // ever there, so this branch claims neither.
            title = `cites \`${cited}\`, which is not in this repository at this revision`;
            body = `This line cites \`${cited}${at}\`. That path is not present at this revision. urtext could not read this line's history here, so it does not know whether the citation ever resolved.`;
            break;
          }
          title = `cites \`${cited}\`, which is not in this repository any more`;
          body = `This line cites \`${cited}${at}\`. That file existed ${when} and is not present at this revision, so the citation does not resolve. What it was meant to point at is not something urtext can recover.`;
          break;
        case "line_out_of_range": {
          const count = num(fact.detail.lineCount, 0);
          title = `cites \`${cited}${at}\`, which is past the end of that file`;
          body = `\`${cited}\` has ${count} line${count === 1 ? "" : "s"} at this revision, so ${spanned ? `lines ${start}-${end} are not all in it` : `line ${start} is not in it`}. The citation resolved ${when}; it resolves to nothing now.`;
          break;
        }
        case "quote_absent": {
          const phrase = str(fact.detail.quote, "the quoted phrase");
          title = `cites \`${cited}\` for a quoted phrase that is not in it`;
          body = `This line cites \`${cited}\` and quotes “${phrase}”. That text was in \`${cited}\` ${when} and is not in it at this revision. urtext compares the quoted text against the file's contents; it does not know whether the text moved, was reworded, or was deliberately dropped.`;
          break;
        }
        default: {
          // A line urtext read as empty is something it knows, not something
          // it is missing. `str`'s fallback exists for a detail that is absent
          // or is not a string; an empty line is neither, and routing it
          // through the fallback printed "something else" — a phrase whose
          // whole meaning is "urtext cannot say" — in place of a fact urtext
          // could state exactly, under a verified badge. Both sides are said
          // as blankness instead, in the same voice as the reading they
          // replace. A detail genuinely absent still takes the fallback, which
          // is the case that phrase was written for.
          const isBlank = (v: unknown): boolean => typeof v === "string" && v.trim() === "";
          const read = isBlank(fact.detail.was)
            ? "was blank"
            : `read \`${str(fact.detail.was, "something else")}\``;
          const readsNow = isBlank(fact.detail.now)
            ? "It is now blank."
            : `It now reads \`${str(fact.detail.now, "something else")}\`.`;
          // On a drift `citedLine` is the line whose content differs, which is
          // where the evidence points — not what the prose wrote. The citation
          // as written is carried separately and is what these sentences name:
          // it is the string a reader searches their own document for and the
          // text they will edit, and a title naming the differing line alone
          // would be a string they could not find. The two are read from
          // separate fields and never combined, so no span the prose did not
          // write can be composed here.
          const wroteStart = num(fact.detail.writtenLine, start);
          const wroteEnd = num(fact.detail.writtenEndLine, 0);
          const wrote =
            wroteStart === 0 ? "" : wroteEnd === 0 ? `:${wroteStart}` : `:${wroteStart}-${wroteEnd}`;
          // Which line inside the citation moved. Said only where the citation
          // reaches more than one line: on a single-line citation it would
          // restate the line just named.
          const inside =
            wroteEnd !== 0 && wroteEnd !== wroteStart && start !== 0 ? `line ${start} of ` : "";
          title = `cites \`${cited}${wrote}\`, which no longer reads the same`;
          // Membership of the cited path in the changed set is proven, so the
          // body states exactly that and nothing more. Attributing the
          // movement to the reviewed change would be a causal claim under a
          // verified badge that the evidence does not carry: the baseline is
          // the commit that last wrote the CITING line, which can predate the
          // reviewed range by any number of commits.
          const touched =
            fact.detail.citedTouched === true ? ` This change touched \`${cited}\`.` : "";
          body = `When this line was last written (${hash}), ${inside}\`${cited}${wrote}\` ${read}. ${readsNow} The citation still resolves to a line; it no longer resolves to the same content. urtext does not know whether the new line is what this sentence meant.${touched}`;
        }
      }
      break;
    }
  }

  return {
    id: fact.id,
    tier: tierFor(fact, undefined),
    file: fact.file,
    line: fact.line,
    title,
    body,
    score: scoreFact(fact),
    evidence: fact.evidence,
  };
}

/**
 * `rank` plus the map a model claim needs to find a fact that no longer has
 * a finding of its own: `absorbedBy` maps a folded/grouped fact's id to the
 * id of the finding that now speaks for it (see `foldReach`,
 * `groupAddedExports`, and `groupSignatureChanges` — the three places facts
 * disappear this way). Chained here because a fact can be absorbed twice in
 * a row — a blast_radius fact folded into an `export_added` or
 * `signature_changed` sibling whose own finding is then itself collapsed
 * into its file's group — and only this function, which runs the fold and
 * both grouping passes itself, sees every step. `reconcile.ts` is the only
 * caller that needs this; everything else calls `rank`, the one-line
 * delegate below, which just discards it.
 */
/**
 * Kinds that report reach or arrival rather than a defect. A finding of one
 * of these names no problem by itself: "this changed and a lot of code uses
 * it", or "this is newly exported" — each is context a reader may want, and
 * neither is something to go and fix.
 *
 * `scoreFact` already caps a blast-radius score so that "no reference count
 * may push it above a fact that does [name a problem]", but a cap is a single
 * number and had to be chosen against the defect kinds that existed when it
 * was written. `citation_rot` arrived later and below it, so on a real pull
 * request a widely-referenced export ranked seven places above the only
 * finding naming something a person could act on.
 *
 * Sorting by band fixes that without touching either weight, and both weights
 * were right: a rotted citation genuinely is less severe than a removed
 * guard, and forty callers genuinely differ from three. The error was using
 * one number to answer two questions — how bad is this, and is it a defect at
 * all. See `test/score/index.test.ts`, "ranks a rotted citation above a
 * widely-referenced export".
 */
const CONTEXT_KINDS: ReadonlySet<Fact["kind"]> = new Set<Fact["kind"]>([
  "blast_radius",
  "export_added",
]);

/**
 * Which band a fact's finding sorts into: the defect band first, the context
 * band after. (Bands are named rather than numbered in this comment because a
 * bare small integer here reads as a restated WEIGHTS value to this
 * repository's comment contract.)
 *
 * Takes the fact's own `kind` rather than recovering it from an id prefix.
 * The report model parses prefixes because a `Finding` is all it ever has;
 * scoring holds the `Fact` itself, and guessing from a string here would be
 * a second, weaker copy of a fact the code already knows — one that answers
 * wrongly for any id not built from a kind, which the tests construct and
 * which nothing forbids.
 */
function bandOf(kind: Fact["kind"]): number {
  return CONTEXT_KINDS.has(kind) ? 1 : 0;
}

/**
 * The band of every finding a fact list will produce, keyed by fact id.
 *
 * A finding with no entry — a standalone model claim, which comes from no
 * fact — sorts in the defect band. Its position within that band is governed
 * by score as before, though it now sits above every context finding whatever
 * their scores: a claim alleges a problem, so the band it lands in is the
 * right one, but that is a change to where claims rank, not a preservation.
 */
function bandsFor(facts: Fact[]): Map<string, number> {
  return new Map(facts.map((fact) => [fact.id, bandOf(fact.kind)]));
}

export function rankWithAbsorption(
  facts: Fact[],
): { findings: Finding[]; absorbedBy: Map<string, string>; bands: Map<string, number> } {
  const { facts: kept, reach, absorbedBy: radiusAbsorbedBy } = foldReach(
    facts,
    (fact) => WEIGHTS.factKind[fact.kind],
  );

  // Recorded while the facts are still in hand, because the sort below runs
  // over findings and a finding does not carry its kind. Group ids are added
  // once the grouping passes have run — see the extension below, which is not
  // optional: `export_added` both groups and is context.
  const band = bandsFor(kept);

  const findings = kept.map((fact) => {
    const finding = toFinding(fact);
    // A blast_radius fact never looks up its own reach entry: that entry
    // is *its own* reference count, so without this guard a lonely
    // blast_radius fact (one with no sibling, kept above) amplifies and
    // restates itself. `toFinding` already wrote the reference count into
    // this finding's body; there is nothing here to add.
    const r =
      fact.kind !== "blast_radius" && fact.qualifiedSymbol
        ? reach.get(reachKey(fact.file, fact.qualifiedSymbol))
        : undefined;
    if (!r) return finding;
    // Computed once and reused below, matching the pattern `groupAddedExports`
    // (`../score/reach.ts`) and `toFinding`'s blast_radius branch (above in
    // this file) both use: the subject is `places`, not the symbol, so the
    // verb has to agree with it — "One place ... references"; "N places ...
    // reference" — rather than being re-derived (or, as this site used to,
    // fixed to the plural form regardless of count).
    const places = r.references === 1 ? "One place" : `${r.references} places`;
    const verb = r.references === 1 ? "references" : "reference";
    return {
      ...finding,
      reach: r,
      // A bounded multiplier, at most 1.5x, applied on top of `scoreFact`'s
      // own ceiling — not a separate score. That means an amplified finding
      // *can* end up above an unamplified higher-weight one (a
      // signature_changed finding reaching 300 references is multiplied by
      // 1.5x its base score, which can put it above an unamplified
      // guard_removed finding) — correctly: a contract change with 300 call
      // sites can matter more than one removed guard.
      // Any guard_removed with the same reach amplifies by the same
      // factor, so comparable findings keep their relative order. What
      // this never does is let a fact amplify *itself*: see the guard on
      // `r`, above.
      score: finding.score * (1 + Math.min(Math.log10(Math.max(r.references, 1)), 1) * 0.5),
      body: `${finding.body} ${places} in this repository ${verb} it.`,
    };
  });

  // Derived from the same facts the findings were built from, so the group
  // listing's sentences and the ungrouped bodies come out of one composer
  // (`describeSignatureChange`) and cannot drift apart. Keyed by fact id,
  // which is also the finding id for an ungrouped fact.
  const signatureDetails = new Map<string, SignatureChangeDetail>();
  for (const fact of kept) {
    if (fact.kind !== "signature_changed") continue;
    const d = describeSignatureChange(fact);
    signatureDetails.set(fact.id, { name: d.name, sentence: d.sentence, typeUnresolved: d.typeUnresolved });
  }

  const { findings: signatureGrouped, absorbedBy: signatureAbsorbedBy } = groupSignatureChanges(
    findings,
    signatureDetails,
  );
  const { findings: grouped, absorbedBy: exportAbsorbedBy } = groupAddedExports(signatureGrouped);

  // The two grouping passes touch disjoint id prefixes, so one merged map
  // can answer for both when the chain below resolves a sibling.
  const groupAbsorbedBy = new Map([...signatureAbsorbedBy, ...exportAbsorbedBy]);

  // A group's id belongs to no fact, so `bandsFor` above cannot have answered
  // for it, and an unanswered id takes the default — the defect band. That is
  // wrong for exactly the kind this banding exists to demote: a file's added
  // exports collapse into one finding that scores as its highest member, so
  // the aggregate would outrank every rotted citation while its two-member
  // form, below the grouping threshold, sorted underneath. A member's band is
  // the group's because grouping is per-kind: every member of a group shares
  // one kind, and `absorbedBy` is the map that already knows which members
  // went where. See `test/score/reconcile.test.ts`, "puts a rotted citation
  // above a file's grouped new exports".
  for (const [factId, groupId] of groupAbsorbedBy) {
    const memberBand = band.get(factId);
    if (memberBand !== undefined) band.set(groupId, memberBand);
  }

  // A blast_radius fact's sibling can itself have been grouped away, so its
  // id no longer names a finding either — resolve through the grouping
  // absorption maps too, falling back to the sibling's own id when it was
  // not grouped (an ungrouped sibling's finding id is just its fact id).
  const absorbedBy = new Map<string, string>();
  for (const [factId, siblingId] of radiusAbsorbedBy) {
    absorbedBy.set(factId, groupAbsorbedBy.get(siblingId) ?? siblingId);
  }
  for (const [factId, groupId] of groupAbsorbedBy) {
    absorbedBy.set(factId, groupId);
  }

  return {
    findings: grouped.sort(
      (a, b) =>
        (band.get(a.id) ?? 0) - (band.get(b.id) ?? 0) ||
        b.score - a.score ||
        a.file.localeCompare(b.file) ||
        a.line - b.line,
    ),
    absorbedBy,
    // Handed to `reconcile` rather than recomputed there, because two sorts
    // order findings and both must agree. Recomputing was the earlier design
    // and it was a second, weaker copy: the group ids above exist only here,
    // where the grouping passes ran, so a caller deriving bands from the
    // facts alone answers wrongly for every grouped finding. Agreement is not
    // optional — `reconcile`'s sort runs last and governs what a reader sees;
    // when the band was applied here alone, a unit test over `rank` passed
    // while the shipped ordering never moved.
    bands: band,
  };
}

export function rank(facts: Fact[]): Finding[] {
  return rankWithAbsorption(facts).findings;
}
