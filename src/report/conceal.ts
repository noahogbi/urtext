/**
 * The concealing-character defense, shared by both report surfaces. It lived
 * in `html.ts` first, which left the terminal — the *default* surface —
 * printing the same hostile bytes raw: a Trojan-source excerpt could be shown
 * to a terminal reader, under a `[verified]` badge, in an order it does not
 * execute in. One table and one substitution, so the surfaces cannot drift:
 * `buildReportModel` in `./model.ts` applies it to every content field while
 * the model is built (structurally via `segmentConcealed`, or as
 * `labelConcealed` strings for identifier-shaped fields), and the surfaces
 * only render what it produced — `html.ts` wraps every segmented field
 * through `seg`, with no concealment path of its own.
 */

/**
 * Characters that render as something other than themselves, or as nothing
 * at all: the bidirectional overrides and isolates a Trojan Source attack
 * uses to make a line of code display in an order it does not execute in,
 * the zero-width and joining characters that can hide inside an identifier,
 * the characters of both control blocks, and the Tag block — deprecated for
 * its original purpose and now the standard way to smuggle an entire ASCII
 * string through a surface that renders nothing for it. Tab and newline are
 * excluded: they are layout in a code excerpt, not concealment.
 *
 * This matters more here than in most renderers. The whole promise of a
 * `verified` finding is "here is the line, look at it yourself", and an
 * excerpt that displays differently from the bytes it quotes breaks exactly
 * that promise — the reader checks the evidence and is shown something
 * else. See `test/report/html.test.ts`, "shows a bidi override in an
 * excerpt rather than obeying it".
 *
 * What this table deliberately does not cover, so that the next reader knows
 * where it stops rather than assuming it stops nowhere:
 *
 * - **Variation selectors** — the `U+FE00`–`U+FE0F` block and the Variation
 *   Selectors Supplement above the Tag block. They can carry a payload the
 *   same way tag characters can, but `U+FE0F` is load-bearing for ordinary
 *   emoji presentation and the supplement encodes legitimate ideographic
 *   variants, so labelling them would corrupt real content in a string
 *   literal or a comment. They are also the weakest of these channels: a
 *   variation selector cannot reorder the text around it or hide another
 *   character — it can only hold data for a decoder that is already
 *   co-operating. The trade lands the other way for the Tag block, whose
 *   only surviving legitimate use is the subdivision-flag emoji sequences;
 *   an excerpt containing one of those will render its base character
 *   followed by tag labels, and that is a cost worth paying in source code.
 * - **Confusables** — a Cyrillic small a (U+0430) standing in for Latin `a`,
 *   a non-breaking space for a space, curly quotes for straight ones. Those
 *   are visible characters that look like *other visible characters*, which
 *   is a different problem needing a confusables table and a policy about
 *   which scripts an identifier may mix. The rule here is narrower and
 *   checkable: a character belongs in this table when it renders as nothing,
 *   or changes the order of what surrounds it.
 */
const CONCEALING_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x61c, 0x61c],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];

export function conceals(code: number): boolean {
  return CONCEALING_RANGES.some(([lo, hi]) => code >= lo && code <= hi);
}

export function codePointLabel(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * One piece of a segmented text: either a verbatim run of ordinary
 * characters, or the label standing in for exactly one concealed character.
 * For a `"concealed"` segment, `text` is the bare code-point label
 * (`U+202E`, no brackets): the HTML report wraps it in its own markup while
 * flat surfaces bracket it through `plainText`, and neither has to parse the
 * other's rendering back apart.
 *
 * The raw character is dropped rather than kept beside the label. Copying an
 * excerpt out of a report should not carry an invisible payload with it, and
 * a reader who needs the original bytes has the file and line printed right
 * above.
 */
export interface ConcealSegment {
  kind: "text" | "concealed";
  text: string;
}

/**
 * The segmenting primitive under every surface's concealment defense: each
 * concealing character becomes its own `"concealed"` segment and everything
 * between them stays one verbatim `"text"` run. The distinction is
 * structural rather than in-band because a flattened label cannot be told
 * apart from source code that literally spells it — a walker parsing
 * `[U+202E]` back out of plain text would style an attacker-written literal
 * as a concealed character. See `test/report/conceal.test.ts`, "leaves a
 * source-written label literal as ordinary text".
 *
 * The ranges are written as code points rather than as a character class in
 * a regular expression literal, because a literal would mean putting the
 * very characters this defends against into this file, where the next
 * reader cannot see them either.
 */
export function segmentConcealed(text: string): ConcealSegment[] {
  const segments: ConcealSegment[] = [];
  let run = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (conceals(code)) {
      if (run) {
        segments.push({ kind: "text", text: run });
        run = "";
      }
      segments.push({ kind: "concealed", text: codePointLabel(code) });
    } else {
      run += ch;
    }
  }
  if (run) segments.push({ kind: "text", text: run });
  return segments;
}

/**
 * Flattens segments for a surface that cannot mark concealment structurally
 * (terminal, Markdown, PDF): text runs verbatim, each concealed label in
 * brackets — `[U+202E]`. By construction this reproduces exactly what
 * `labelConcealed` says about the same input; see
 * `test/report/conceal.test.ts`, "reproduces exactly the string
 * labelConcealed produces, for any input".
 */
export function plainText(segments: ConcealSegment[]): string {
  return segments
    .map((s) => (s.kind === "concealed" ? `[${s.text}]` : s.text))
    .join("");
}

/**
 * Plain text with every concealing character replaced by a bracketed label
 * of its own code point — `[U+202E]` — and everything else kept verbatim.
 * Built on the segmenting primitive above so the flattened and structural
 * forms cannot disagree about what was concealed.
 */
export function labelConcealed(text: string): string {
  return plainText(segmentConcealed(text));
}
