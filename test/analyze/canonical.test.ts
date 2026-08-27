import { describe, expect, it } from "vitest";
import { canonicalSignature } from "../../src/analyze/canonical.js";

// The defect class this pins: `checker.typeToString` prints a union's members
// in type-interning order — the order each member type was first materialized
// anywhere in that program's checking history — not source order. Two
// separately-built programs can therefore print the SAME type differently,
// and a raw string comparison then reports a `verified` signature change for
// source that never changed. Canonicalization makes comparison order-blind
// for every set-semantic construct, at every nesting depth.
const same = (a: string, b: string) =>
  expect(canonicalSignature(a)).toBe(canonicalSignature(b));
const different = (a: string, b: string) =>
  expect(canonicalSignature(a)).not.toBe(canonicalSignature(b));

describe("canonicalSignature", () => {
  it("equates unions nested inside an object type, whatever their printed order", () => {
    same(
      '{ kind: "bulletin_item" | "post"; title: string }',
      '{ kind: "post" | "bulletin_item"; title: string }',
    );
  });

  it("equates unions nested inside generics, arrays, and function parameters", () => {
    same('Map<string, "x" | "y">', 'Map<string, "y" | "x">');
    same('("a" | "b")[]', '("b" | "a")[]');
    same('(k: "a" | "b") => void', '(k: "b" | "a") => void');
  });

  it("equates top-level unions and unions of object types", () => {
    same('"a" | "b" | "c"', '"c" | "a" | "b"');
    same("{ p: string } | { q: number }", "{ q: number } | { p: string }");
  });

  it("equates intersections regardless of order", () => {
    same("A & B", "B & A");
  });

  it("equates object types whose members were only reordered, at any depth", () => {
    same(
      "{ p: { a: string; b: number } }",
      "{ p: { b: number; a: string } }",
    );
  });

  it("keeps genuinely different types different", () => {
    different('"a" | "b"', '"a" | "b" | "c"');
    different('{ kind: "a" | "b" }', '{ kind: "a" | "c" }');
    different("{ a: string }", "{ a: string; b: number }");
    different("(k: string) => void", "(k: number) => void");
  });

  it("is not fooled by separators inside string-literal types", () => {
    // The pipe lives inside the literal text, not the type grammar; only a
    // real parser can tell. A change here is a real change.
    different('{ k: "a | b" }', '{ k: "b | a" }');
    same('"a | b" | "c"', '"c" | "a | b"');
  });

  it("returns unparseable text unchanged, so comparison degrades to raw equality", () => {
    const cut = '{ kind: "post" | "bul';
    expect(canonicalSignature(cut)).toBe(cut);
  });

  it("is idempotent", () => {
    const once = canonicalSignature('{ kind: "b" | "a"; z: { y: 1; x: 2 } }');
    expect(canonicalSignature(once)).toBe(once);
  });
});
