import { describe, expect, it } from "vitest";
import { LOCAL_SCOPE } from "../../src/extract/scope.js";
import { isTypeScriptFile, mapSymbols } from "../../src/extract/symbols.js";

const BEFORE = `export function alpha() {
  return 1;
}

function beta() {
  return 2;
}

export class Gamma {
  method() {
    return 3;
  }
}
`;

const AFTER = `export function alpha() {
  return 99;
}

function beta() {
  return 2;
}

export class Gamma {
  method() {
    return 3;
  }
}

export function delta() {
  return 4;
}
`;

describe("isTypeScriptFile", () => {
  it("accepts .ts and .tsx", () => {
    expect(isTypeScriptFile("a/b.ts")).toBe(true);
    expect(isTypeScriptFile("a/b.tsx")).toBe(true);
  });

  it("accepts the explicit ESM and CJS extensions", () => {
    // `.mts`/`.cts` are ordinary TypeScript implementation files. Rejecting
    // them made every such file invisible to every analyzer, with no
    // disclosure — "No findings" on a `.mts`-only change was
    // indistinguishable from a clean review.
    expect(isTypeScriptFile("a/b.mts")).toBe(true);
    expect(isTypeScriptFile("a/b.cts")).toBe(true);
  });

  it("rejects declaration files in every extension flavour", () => {
    expect(isTypeScriptFile("a/b.d.ts")).toBe(false);
    expect(isTypeScriptFile("a/b.d.mts")).toBe(false);
    expect(isTypeScriptFile("a/b.d.cts")).toBe(false);
  });

  it("rejects everything else", () => {
    expect(isTypeScriptFile("a/b.js")).toBe(false);
    expect(isTypeScriptFile("a/b.md")).toBe(false);
    expect(isTypeScriptFile("a/b.d.ts.map")).toBe(false);
    // No `.mtsx`/`.ctsx` exist: JSX never got module-explicit flavours.
    expect(isTypeScriptFile("a/b.mtsx")).toBe(false);
    expect(isTypeScriptFile("a/b.ctsx")).toBe(false);
  });
});

describe("mapSymbols", () => {
  it("marks a symbol modified when a hunk falls inside it", () => {
    const hunks = [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }];
    const syms = mapSymbols("a.ts", BEFORE, AFTER, hunks);
    const alpha = syms.find((s) => s.name === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.change).toBe("modified");
    expect(alpha!.kind).toBe("function");
    expect(alpha!.exported).toBe(true);
  });

  it("does not report symbols no hunk touches", () => {
    const hunks = [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }];
    const syms = mapSymbols("a.ts", BEFORE, AFTER, hunks);
    expect(syms.find((s) => s.name === "beta")).toBeUndefined();
  });

  it("marks a symbol added when it is absent before", () => {
    const hunks = [{ oldStart: 13, oldLines: 0, newStart: 14, newLines: 3 }];
    const syms = mapSymbols("a.ts", BEFORE, AFTER, hunks);
    const delta = syms.find((s) => s.name === "delta");
    expect(delta).toBeDefined();
    expect(delta!.change).toBe("added");
  });

  it("marks a symbol removed when it is absent after", () => {
    const syms = mapSymbols("a.ts", AFTER, BEFORE, [
      { oldStart: 14, oldLines: 3, newStart: 13, newLines: 0 },
    ]);
    const delta = syms.find((s) => s.name === "delta");
    expect(delta).toBeDefined();
    expect(delta!.change).toBe("removed");
    expect(delta!.range).toEqual({ startLine: 0, endLine: 0 });
  });

  it("records class methods with their own names", () => {
    const hunks = [{ oldStart: 11, oldLines: 1, newStart: 11, newLines: 1 }];
    const syms = mapSymbols("a.ts", BEFORE, AFTER, hunks);
    expect(syms.map((s) => s.name)).toContain("method");
    expect(syms.find((s) => s.name === "method")!.kind).toBe("method");
  });

  it("returns nothing when the after-content is missing", () => {
    expect(mapSymbols("a.ts", BEFORE, null, [])).toEqual([]);
  });
});

const TWO_CLASSES_BEFORE = `export class Alpha {
  render() {
    return 1;
  }
}

export class Beta {
  render() {
    return 2;
  }
}
`;

const TWO_CLASSES_AFTER = `export class Alpha {
}

export class Beta {
  render() {
    return 2;
  }
}
`;

const TWO_CLASS_EXPRS_BEFORE = `const Alpha = class {
  render() {
    return 1;
  }
};

const Beta = class {
  render() {
    return 2;
  }
};
`;

const TWO_CLASS_EXPRS_AFTER = `const Alpha = class {
};

const Beta = class {
  render() {
    return 2;
  }
};
`;

describe("mapSymbols qualified names", () => {
  it("qualifies a method with its containing class", () => {
    const syms = mapSymbols("a.ts", TWO_CLASSES_BEFORE, TWO_CLASSES_BEFORE, [
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
    ]);
    const m = syms.find((s) => s.qualifiedName === "Alpha.render");
    expect(m).toBeDefined();
    expect(m!.name).toBe("render");
  });

  it("leaves a top-level declaration's qualified name equal to its name", () => {
    const syms = mapSymbols("a.ts", BEFORE, AFTER, [
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
    ]);
    const alpha = syms.find((s) => s.name === "alpha")!;
    expect(alpha.qualifiedName).toBe("alpha");
  });

  it("reports a method removed from one class even when a sibling keeps that name", () => {
    const syms = mapSymbols(
      "a.ts",
      TWO_CLASSES_BEFORE,
      TWO_CLASSES_AFTER,
      [{ oldStart: 2, oldLines: 3, newStart: 2, newLines: 0 }],
    );
    const removed = syms.filter((s) => s.change === "removed");
    expect(removed.map((s) => s.qualifiedName)).toContain("Alpha.render");
    expect(removed.map((s) => s.qualifiedName)).not.toContain("Beta.render");
  });

  it("reports a method removed from one class expression even when a sibling keeps that name", () => {
    const syms = mapSymbols(
      "a.ts",
      TWO_CLASS_EXPRS_BEFORE,
      TWO_CLASS_EXPRS_AFTER,
      [{ oldStart: 2, oldLines: 3, newStart: 2, newLines: 0 }],
    );
    const removed = syms.filter((s) => s.change === "removed");
    expect(removed.map((s) => s.qualifiedName)).toContain("Alpha.render");
    expect(removed.map((s) => s.qualifiedName)).not.toContain("Beta.render");
  });

  it("reports an overloaded function once, spanning its signatures and implementation", () => {
    const src = `export function fmt(a: string): string; // a string
export function fmt(a: number): string; // a number
export function fmt(a: string | number): string {
  return String(a);
}
`;
    const syms = mapSymbols("a.ts", src, src, [
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 },
    ]);
    const fmt = syms.filter((s) => s.qualifiedName === "fmt");
    expect(fmt).toHaveLength(1);
    expect(fmt[0].change).toBe("modified");
    expect(fmt[0].exported).toBe(true);
    // The first signature through the implementation's closing brace.
    expect(fmt[0].range).toEqual({ startLine: 1, endLine: 5 });
  });

  it("reports two merged interface declarations as one symbol", () => {
    const src = `export interface Config {
  a: string;
}
export interface Config {
  b: number;
}
`;
    const syms = mapSymbols("a.ts", src, src, [
      { oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 },
    ]);
    const config = syms.filter((s) => s.qualifiedName === "Config");
    expect(config).toHaveLength(1);
    expect(config[0].kind).toBe("type");
  });

  it("reports a removed overloaded function once, not once per signature", () => {
    const before = `export function fmt(a: string): string;
export function fmt(a: number): string;
export function fmt(a: string | number): string {
  return String(a);
}
`;
    const syms = mapSymbols("a.ts", before, "export const other = 1;\n", [
      { oldStart: 1, oldLines: 5, newStart: 1, newLines: 1 },
    ]);
    const fmt = syms.filter((s) => s.qualifiedName === "fmt");
    expect(fmt).toHaveLength(1);
    expect(fmt[0].change).toBe("removed");
  });

  it("qualifies a method inside an anonymous default-export class as 'default'", () => {
    const src = `export default class {
  render() {
    return 1;
  }
}
`;
    const syms = mapSymbols("a.ts", src, src, [
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
    ]);
    const m = syms.find((s) => s.qualifiedName === "default.render");
    expect(m).toBeDefined();
    expect(m!.name).toBe("render");
  });

  it("merges a class and an interface of the same name, which is one symbol", () => {
    const src = `export class Box {
  hold() {}
}
export interface Box {
  size: number;
}
`;
    const syms = mapSymbols("a.ts", src, src, [
      { oldStart: 1, oldLines: 6, newStart: 1, newLines: 6 },
    ]);
    const box = syms.filter((s) => s.qualifiedName === "Box");
    expect(box).toHaveLength(1);
    expect(box[0].exported).toBe(true);
    // Source order decides the kind when a merge spans two of them.
    expect(box[0].kind).toBe("class");
    expect(box[0].range).toEqual({ startLine: 1, endLine: 6 });
  });
});

describe("mapSymbols scope frames", () => {
  it("qualifies a local by its function and the local marker, so it cannot merge with a top-level export", () => {
    const src = `export function wrapper(n: number): number {
  const format = n + 1;
  return format;
}
export function format(a: string): string {
  return a;
}
`;
    const syms = mapSymbols("a.ts", src, src, [
      { oldStart: 1, oldLines: 7, newStart: 1, newLines: 7 },
    ]);
    // The function body is a statement scope, so the local carries the
    // `LOCAL_SCOPE` segment — which is also what keeps it off the path of a
    // member of a namespace merged with `wrapper`.
    const local = syms.find((s) => s.qualifiedName === `wrapper.${LOCAL_SCOPE}.format`)!;
    expect(local.kind).toBe("variable");
    expect(local.exported).toBe(false);
    const exported = syms.find((s) => s.qualifiedName === "format")!;
    expect(exported.kind).toBe("function");
    expect(exported.exported).toBe(true);
    expect(exported.range.startLine).toBe(5);
  });

  it("qualifies a namespace member and does not call it a module export", () => {
    const src = `export namespace N {
  export const x = 1;
}
export const x = 2;
`;
    const syms = mapSymbols("a.ts", src, src, [
      { oldStart: 1, oldLines: 4, newStart: 1, newLines: 4 },
    ]);
    // Exported from the namespace, not from the file: an importer reaches it
    // as `N.x`, and `blastRadiusAnalyzer` looks a module export up by bare
    // name — where it would have found the unrelated `x` below.
    const member = syms.find((s) => s.qualifiedName === "N.x")!;
    expect(member.exported).toBe(false);
    const moduleExport = syms.find((s) => s.qualifiedName === "x")!;
    expect(moduleExport.exported).toBe(true);
    expect(moduleExport.range.startLine).toBe(4);
  });

  it("marks a declaration in a top-level block as local rather than as a top-level name", () => {
    const src = `for (const n of [1]) {
  const format = n;
  void format;
}
export function format(a: string): string {
  return a;
}
`;
    const syms = mapSymbols("a.ts", src, src, [
      { oldStart: 1, oldLines: 7, newStart: 1, newLines: 7 },
    ]);
    // No enclosing function or class can name this scope, so the sentinel is
    // what keeps it from merging with the export below it.
    expect(syms.some((s) => s.qualifiedName === `${LOCAL_SCOPE}.format`)).toBe(true);
    const exported = syms.find((s) => s.qualifiedName === "format")!;
    expect(exported.kind).toBe("function");
    expect(exported.exported).toBe(true);
  });

  it("qualifies a local inside an anonymous default-export function under 'default'", () => {
    // The same name an anonymous default-export *class* frames: the module's
    // principal export is nameable either way, and no identifier can collide
    // with `default` in that position.
    const src = `export default function () {
  const format = 1;
  void format;
}
`;
    const syms = mapSymbols("a.ts", src, src, [
      { oldStart: 1, oldLines: 4, newStart: 1, newLines: 4 },
    ]);
    expect(syms.map((s) => s.qualifiedName)).toContain(`default.${LOCAL_SCOPE}.format`);
  });

  it("records an exported enum, so a member change reaches the symbol map", () => {
    // Enums were the one declaration form `declarations()` skipped entirely:
    // an exported enum never got a symbol row, so a member added to it
    // produced no surface row, no blast radius, and no finding anywhere.
    const before = `export enum Mode {
  A = "a",
  B = "b",
}
`;
    const after = `export enum Mode {
  A = "a",
  B = "b",
  C = "c",
}
`;
    const syms = mapSymbols("a.ts", before, after, [
      { oldStart: 3, oldLines: 0, newStart: 4, newLines: 1 },
    ]);
    const mode = syms.find((s) => s.qualifiedName === "Mode");
    expect(mode).toBeDefined();
    expect(mode!.kind).toBe("enum");
    expect(mode!.exported).toBe(true);
    expect(mode!.change).toBe("modified");
  });

  it("reports a deleted exported enum as a removed symbol", () => {
    const before = `export enum Mode {
  A = "a",
}
export const keep = 1;
`;
    const after = "export const keep = 1;\n";
    const syms = mapSymbols("a.ts", before, after, [
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 0 },
    ]);
    const mode = syms.find((s) => s.qualifiedName === "Mode");
    expect(mode).toBeDefined();
    expect(mode!.change).toBe("removed");
    expect(mode!.kind).toBe("enum");
  });

  it("records a private method under its own #name", () => {
    const src = `export class Vault {
  #unlock(pin: string): string {
    return pin;
  }
}
`;
    const syms = mapSymbols("a.ts", src, src, [
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
    ]);
    const m = syms.find((s) => s.qualifiedName === "Vault.#unlock");
    expect(m).toBeDefined();
    expect(m!.name).toBe("#unlock");
    expect(m!.kind).toBe("method");
    expect(m!.exported).toBe(false);
  });
});
