import { describe, expect, it } from "vitest";
import { collectGuards, guardsAnalyzer } from "../../src/analyze/guards.js";
import { WORKTREE, type AnalysisContext, type Changeset } from "../../src/types.js";

const BEFORE = `export function validate(token: string) {
  if (!token) {
    throw new Error("missing token");
  }
  return { token, ok: true };
}
`;

const AFTER = `export function validate(token: string) {
  return { token, ok: true };
}
`;

const AFTER_KEPT = `export function validate(token: string) {
  if (!token) {
    throw new Error("missing token");
  }
  return { token, ok: true, checked: true };
}
`;

// No type annotation on the parameter — this is JavaScript, parsed under
// the JS ScriptKind rather than TS.
const MJS_THROWING_GUARD = `export function validate(token) {
  if (!token) {
    throw new Error("missing token");
  }
  return token;
}
`;

const MJS_BEFORE = `export function validate(token) {
  if (!token) {
    throw new Error("missing token");
  }
  return { token, ok: true };
}
`;

const MJS_AFTER = `export function validate(token) {
  return { token, ok: true };
}
`;

describe("collectGuards", () => {
  it("finds an if-guard and attributes it to its enclosing function", () => {
    const guards = collectGuards("a.ts", BEFORE);
    const g = guards.find((x) => x.signature.startsWith("if"));
    expect(g).toBeDefined();
    expect(g!.qualifiedOwner).toBe("validate");
    expect(g!.line).toBe(2);
  });

  it("finds a throw", () => {
    expect(collectGuards("a.ts", BEFORE).some((g) => g.signature.startsWith("throw"))).toBe(true);
  });

  it("returns nothing for code with no guards", () => {
    expect(collectGuards("a.ts", AFTER)).toEqual([]);
  });

  it("ignores non-TypeScript files", () => {
    expect(collectGuards("a.md", BEFORE)).toEqual([]);
  });

  it("finds a throwing early guard in a .mjs file, at its real line", () => {
    const guards = collectGuards("a.mjs", MJS_THROWING_GUARD);
    const g = guards.find((x) => x.signature.startsWith("throw"));
    expect(g).toBeDefined();
    expect(g!.qualifiedOwner).toBe("validate");
    expect(g!.line).toBe(3);
    expect(g!.excerpt).toContain("missing token");
  });
});

function ctxFor(files: Record<string, { before: string | null; after: string | null }>): AnalysisContext {
  return {
    cwd: "/tmp",
    range: { from: "abc", to: WORKTREE, label: "vs main" },
    async readAt(rev, path) {
      const e = files[path];
      if (!e) return null;
      return rev === WORKTREE ? e.after : e.before;
    },
    async programAt(): Promise<never> {
      throw new Error("guardsAnalyzer must not build a program");
    },
  };
}

const changesetFor = (path: string): Changeset => ({
  range: { from: "abc", to: WORKTREE, label: "vs main" },
  files: [{ path, status: "modified", hunks: [], symbols: [] }],
});

describe("guardsAnalyzer", () => {
  it("reports a guard removed from a surviving symbol", async () => {
    const facts = await guardsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before: BEFORE, after: AFTER } }),
    );
    expect(facts).toHaveLength(2); // the if and the throw
    expect(facts.every((f) => f.kind === "guard_removed")).toBe(true);
    expect(facts[0].qualifiedSymbol).toBe("validate");
    expect(facts[0].evidence[0].excerpt).toContain("if (!token)");
  });

  it("reports a guard removed from a surviving JavaScript symbol", async () => {
    // Same shape as the TypeScript case above, but the function's *last*
    // guard is the one removed — the function itself is untouched otherwise,
    // so it carries no guards at all in the after-side `collectGuards`
    // output. Recognising it as surviving (rather than as a vanished symbol)
    // depends on `collectDeclaredOwners` parsing the after-text as
    // JavaScript, which only happens if both the analyzer's own per-file
    // gate and `collectDeclaredOwners`'s gate admit a `.mjs` path.
    const facts = await guardsAnalyzer(
      changesetFor("a.mjs"),
      ctxFor({ "a.mjs": { before: MJS_BEFORE, after: MJS_AFTER } }),
    );
    expect(facts).toHaveLength(2);
    expect(facts.every((f) => f.kind === "guard_removed")).toBe(true);
    expect(facts[0].qualifiedSymbol).toBe("validate");
  });

  it("stays silent when the guard survives", async () => {
    const facts = await guardsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before: BEFORE, after: AFTER_KEPT } }),
    );
    expect(facts).toEqual([]);
  });

  it("stays silent when the whole symbol is gone", async () => {
    const facts = await guardsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before: BEFORE, after: "export const unrelated = 1;\n" } }),
    );
    expect(facts).toEqual([]);
  });

  it("does not treat an unreadable after-side as a removal", async () => {
    const facts = await guardsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before: BEFORE, after: null } }),
    );
    expect(facts).toEqual([]);
  });

  it("reports a removed top-level guard even though the module itself survives", async () => {
    const before = `if (!process.env.TOKEN) {
  throw new Error("missing env");
}
export function noop() {}
`;
    const after = `export function noop() {}
`;
    const facts = await guardsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before, after } }),
    );
    expect(facts).toHaveLength(2); // the if and the throw
    expect(facts.every((f) => f.qualifiedSymbol === "<module>")).toBe(true);
  });

  it("uses the before-path for Fact.file on a renamed file, matching its evidence", async () => {
    const oldPath = "old.ts";
    const newPath = "new.ts";
    const renamedChangeset: Changeset = {
      range: { from: "abc", to: WORKTREE, label: "vs main" },
      files: [
        { path: newPath, previousPath: oldPath, status: "renamed", hunks: [], symbols: [] },
      ],
    };
    const ctx: AnalysisContext = {
      cwd: "/tmp",
      range: { from: "abc", to: WORKTREE, label: "vs main" },
      async readAt(rev, path) {
        if (rev === WORKTREE) return path === newPath ? AFTER : null;
        return path === oldPath ? BEFORE : null;
      },
      async programAt(): Promise<never> {
        throw new Error("guardsAnalyzer must not build a program");
      },
    };

    const facts = await guardsAnalyzer(renamedChangeset, ctx);
    expect(facts).toHaveLength(2);
    for (const f of facts) {
      // Fact.file/Fact.line must name the same file the evidence points at
      // (the old name, since that is where the removed guard's text lives),
      // not the new post-rename path.
      expect(f.file).toBe(oldPath);
      expect(f.evidence[0].file).toBe(oldPath);
    }
  });

  it("does not report an edited condition as a removal", async () => {
    // The false positive this pins, taken verbatim from this branch's own
    // diff (src/extract/symbols.ts): the guard is still there, an earlier
    // task renamed the operand it reads. Guard identity includes the
    // condition text, so on identity alone this presented as a pure
    // removal — top of the report, the heaviest fact kind, with no
    // compensating "added" fact anywhere.
    const before = `export function diff(afterNames: Set<string>, decls: D[]) {
  for (const d of decls) {
    if (afterNames.has(d.name)) continue;
    out.push(d);
  }
}
`;
    const after = `export function diff(afterNames: Set<string>, decls: D[]) {
  for (const d of decls) {
    if (afterNames.has(d.qualifiedName)) continue;
    out.push(d);
  }
}
`;
    const facts = await guardsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before, after } }),
    );
    expect(facts).toEqual([]);
  });

  it("does not report a narrowed else-if chain as a removal", async () => {
    // The other two false positives from this branch's own diff
    // (src/analyze/effects.ts): both `else if` conditions were narrowed,
    // neither was deleted. The symbol still runs the same number of `if`
    // guards afterwards.
    const before = `export function visit(node: Node) {
  if (isProperty(node)) {
    push(node);
  } else if (isIdentifier(node.expression)) {
    push(node);
  } else if (isCall(node)) {
    push(node);
  }
}
`;
    const after = `export function visit(node: Node) {
  if (isProperty(node)) {
    push(node);
  } else if (isIdentifier(node.expression) && bindings.has(node.expression.text)) {
    push(node);
  } else if (isCall(node) && isIdentifier(node.expression)) {
    push(node);
  }
}
`;
    const facts = await guardsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before, after } }),
    );
    expect(facts).toEqual([]);
  });

  it("reports a deletion when one of two identical guards is removed", async () => {
    // Counting is a multiset, so this case — invisible to set-based
    // matching, since the surviving twin still carries the same signature —
    // falls out for free.
    const before = `export function check(a: string, b: string) {
  if (!a) {
    return null;
  }
  if (!a) {
    return null;
  }
  return b;
}
`;
    const after = `export function check(a: string, b: string) {
  if (!a) {
    return null;
  }
  return b;
}
`;
    const facts = await guardsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before, after } }),
    );
    const ifs = facts.filter((f) => f.detail.guard === "if");
    expect(ifs).toHaveLength(1);
    expect(ifs[0].qualifiedSymbol).toBe("check");
  });

  it("marks removal evidence as before-side, since the line need not exist now", async () => {
    const facts = await guardsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before: BEFORE, after: AFTER } }),
    );
    expect(facts.length).toBeGreaterThan(0);
    for (const f of facts) {
      expect(f.evidence[0].side).toBe("before");
      // Derived from evidence[0] by makeFact, never passed separately.
      expect(f.file).toBe(f.evidence[0].file);
      expect(f.line).toBe(f.evidence[0].line);
    }
  });

  it("attributes guards in named arrow functions, so removing one doesn't mask a surviving twin", async () => {
    const before = `export const validate = (token: string) => {
  if (!token) {
    throw new Error("missing token");
  }
  return token;
};
export const check = (token: string) => {
  if (!token) {
    throw new Error("missing token");
  }
  return token;
};
`;
    const after = `export const validate = (token: string) => {
  return token;
};
export const check = (token: string) => {
  if (!token) {
    throw new Error("missing token");
  }
  return token;
};
`;
    const facts = await guardsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before, after } }),
    );
    // Only validate's guards were removed; check's identical-looking guard
    // must not be conflated with validate's under a shared "<module>" key.
    expect(facts).toHaveLength(2); // the if and the throw, both from validate
    expect(facts.every((f) => f.qualifiedSymbol === "validate")).toBe(true);
  });

  it("qualifies a method by its class, so two classes' same-named methods stay apart", async () => {
    const before = `export class Left {
  render(a: string) {
    if (!a) {
      throw new Error("empty");
    }
    return a;
  }
}
export class Right {
  render(a: string) {
    if (!a) {
      throw new Error("empty");
    }
    return a;
  }
}
`;
    const after = `export class Left {
  render(a: string) {
    return a;
  }
}
export class Right {
  render(a: string) {
    if (!a) {
      throw new Error("empty");
    }
    return a;
  }
}
`;
    const facts = await guardsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before, after } }),
    );
    // Only Left lost its guards. On an unqualified "render" key, Right's
    // surviving guard matched Left's removed one and this was silent.
    expect(facts).toHaveLength(2); // the if and the throw, both from Left
    expect(facts.every((f) => f.qualifiedSymbol === "Left.render")).toBe(true);
  });

  it("attributes a method's guard to Class.method, not to a same-named top-level function", async () => {
    const before = `export function run(a: string) {
  return a;
}
export class Worker {
  run(a: string) {
    if (!a) {
      throw new Error("empty");
    }
    return a;
  }
}
`;
    const after = `export function run(a: string) {
  return a;
}
export class Worker {
  run(a: string) {
    return a;
  }
}
`;
    const facts = await guardsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before, after } }),
    );
    expect(facts).toHaveLength(2); // the if and the throw
    expect(facts.every((f) => f.qualifiedSymbol === "Worker.run")).toBe(true);
    // What `foldReach` matches on across analyzers: an unqualified "run" here
    // collides with the top-level export's blast_radius fact.
    expect(facts.some((f) => f.qualifiedSymbol === "run")).toBe(false);
  });

  it("attributes a static initializer block's guard to the class", async () => {
    // A class body holds no statements except this one construct, and it
    // introduces no owner frame of its own — so the class is the owner.
    // `frameNameOf`'s doc says exactly that; it used to claim a class never
    // owns a guard, which this falsifies.
    const before = `export class Boot {
  static {
    if (!process.env.TOKEN) {
      throw new Error("missing env");
    }
  }
}
`;
    const after = `export class Boot {
  static {
  }
}
`;
    const facts = await guardsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before, after } }),
    );
    expect(facts).toHaveLength(2); // the if and the throw
    expect(facts.every((f) => f.qualifiedSymbol === "Boot")).toBe(true);
  });

  it("qualifies a function inside a namespace by the namespace", async () => {
    const before = `export namespace N {
  export function check(a: string) {
    if (!a) {
      throw new Error("empty");
    }
    return a;
  }
}
`;
    const after = `export namespace N {
  export function check(a: string) {
    return a;
  }
}
`;
    const facts = await guardsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before, after } }),
    );
    expect(facts).toHaveLength(2); // the if and the throw
    // The same path `mapSymbols` gives that function, from the same rule.
    expect(facts.every((f) => f.qualifiedSymbol === "N.check")).toBe(true);
  });
});
