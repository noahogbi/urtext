/**
 * Satisfies the `@napi-rs/canvas` references in unpdf's type declarations.
 * That package is an OPTIONAL peer unpdf needs only for rendering pages as
 * images; the tests here extract text and never touch that surface, and the
 * native canvas build is far too heavy to install for a type reference. This
 * project compiles without `skipLibCheck`, so the unresolved import in
 * unpdf's `.d.mts` would otherwise fail `tsc --noEmit` outright — this stub
 * declares just the two type names unpdf's declarations import, instead of
 * turning off library checking for everything.
 */
declare module "@napi-rs/canvas" {
  export type Canvas = unknown;
  export type SKRSContext2D = unknown;
}
