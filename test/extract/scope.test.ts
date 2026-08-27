import { describe, expect, it } from "vitest";
import { collectGuards } from "../../src/analyze/guards.js";
import {
  ANONYMOUS_OWNER,
  GETTER_FRAME_PREFIX,
  LOCAL_SCOPE,
  MODULE_OWNER,
  SETTER_FRAME_PREFIX,
} from "../../src/extract/scope.js";
import { mapSymbols } from "../../src/extract/symbols.js";

/**
 * The invariant `scope.ts` claims and three files' comments repeat: the two
 * consumers of the qualification rule produce the same path for the same
 * declaration. Nothing tested it, and they disagreed — `mapSymbols` had grown
 * an unnamed-scope rule that `collectGuards` had not, and object literals
 * framed nothing at all, so a guard in `handlers.run` was attributed to a
 * top-level `run` beside it.
 *
 * Every case here declares one guard-carrying symbol and asks both sides what
 * it is called. The guard is what `collectGuards` keys on; the declaration is
 * what `mapSymbols` keys on; `foldReach` matches facts across analyzers on the
 * result, so a difference is a fact about one symbol filed under another.
 */

/** A whole-file hunk, so every declaration in the fixture is reported. */
const wholeFile = (text: string) => {
  const lines = text.split("\n").length;
  return [{ oldStart: 1, oldLines: lines, newStart: 1, newLines: lines }];
};

interface Shape {
  /** What the case is about, in the test name. */
  what: string;
  src: string;
  /** The path both sides must produce for the guard-carrying declaration. */
  path: string;
  /** The declaration's bare name, to find it in the symbol map. */
  name: string;
}

const SHAPES: Shape[] = [
  {
    what: "a top-level function",
    src: `export function run(x: number): number {
  if (x < 0) {
    throw new Error("negative");
  }
  return x;
}
`,
    path: "run",
    name: "run",
  },
  {
    what: "a class method",
    src: `export class Worker {
  run(x: number): number {
    if (x < 0) {
      throw new Error("negative");
    }
    return x;
  }
}
`,
    path: "Worker.run",
    name: "run",
  },
  {
    what: "an object-literal method",
    src: `export const handlers = {
  run(x: number): number {
    if (x < 0) {
      throw new Error("negative");
    }
    return x;
  },
};
`,
    path: "handlers.run",
    name: "run",
  },
  {
    what: "a function inside a namespace",
    src: `export namespace N {
  export function run(x: number): number {
    if (x < 0) {
      throw new Error("negative");
    }
    return x;
  }
}
`,
    path: "N.run",
    name: "run",
  },
  {
    what: "a top-level arrow",
    src: `export const run = (x: number): number => {
  if (x < 0) {
    throw new Error("negative");
  }
  return x;
};
`,
    path: "run",
    name: "run",
  },
  {
    what: "an arrow in a top-level block",
    src: `for (const n of [1]) {
  const run = (x: number): number => {
    if (x < 0) {
      throw new Error("negative");
    }
    return x;
  };
  void run;
  void n;
}
`,
    path: `${LOCAL_SCOPE}.run`,
    name: "run",
  },
  {
    what: "a named function expression bound to a name",
    src: `export const run = function inner(x: number): number {
  if (x < 0) {
    throw new Error("negative");
  }
  return x;
};
`,
    // The binding, not the expression's internal name: `inner` is in scope
    // only inside the expression, and `mapSymbols` records the binding.
    path: "run",
    name: "run",
  },
  {
    what: "a method of a class expression bound to a name",
    src: `export const Worker = class Inner {
  run(x: number): number {
    if (x < 0) {
      throw new Error("negative");
    }
    return x;
  }
};
`,
    path: "Worker.run",
    name: "run",
  },
  {
    what: "a local declared in a class's static initializer block",
    src: `export class Registry {
  static {
    const helper = (x: number): number => {
      if (x < 0) {
        throw new Error("negative");
      }
      return x;
    };
    void helper;
  }
}
`,
    path: `Registry.${LOCAL_SCOPE}.helper`,
    name: "helper",
  },
  {
    what: "a local declared in a function body",
    src: `export function wrapper(a: string): string {
  const check = (v: string): string => {
    if (v === "") {
      throw new Error("empty");
    }
    return v;
  };
  return check(a);
}
`,
    path: `wrapper.${LOCAL_SCOPE}.check`,
    name: "check",
  },
  {
    what: "a private method",
    src: `export class Vault {
  #unlock(pin: string): string {
    if (pin.length < 4) {
      throw new Error("short");
    }
    return pin;
  }
  use(pin: string): string {
    return this.#unlock(pin);
  }
}
`,
    path: "Vault.#unlock",
    name: "#unlock",
  },
  {
    what: "a getter",
    src: `export class Config {
  private _v = "x";
  get value(): string {
    if (this._v === "") {
      throw new Error("unset");
    }
    return this._v;
  }
}
`,
    path: `Config.${GETTER_FRAME_PREFIX}value`,
    name: `${GETTER_FRAME_PREFIX}value`,
  },
  {
    what: "a setter",
    src: `export class Config {
  private _v = "x";
  set value(v: string) {
    if (v === "") {
      throw new Error("unset");
    }
    this._v = v;
  }
}
`,
    path: `Config.${SETTER_FRAME_PREFIX}value`,
    name: `${SETTER_FRAME_PREFIX}value`,
  },
  {
    what: "a method of a function-local object literal",
    src: `export function api(y: number): number {
  const handlers = {
    run(v: number): number {
      if (v > 10) {
        throw new Error("too big");
      }
      return v;
    },
  };
  return handlers.run(y);
}
`,
    path: `api.${LOCAL_SCOPE}.handlers.run`,
    name: "run",
  },
];

describe("the guards path and the symbol map agree on a declaration's path", () => {
  for (const shape of SHAPES) {
    it(`agrees about ${shape.what}`, () => {
      const guard = collectGuards("a.ts", shape.src).find((g) =>
        g.signature.startsWith("if"),
      );
      expect(guard, "fixture declares no if-guard").toBeDefined();

      const symbols = mapSymbols("a.ts", shape.src, shape.src, wholeFile(shape.src));
      const paths = symbols.map((s) => s.qualifiedName);

      expect(guard!.qualifiedOwner).toBe(shape.path);
      expect(paths).toContain(shape.path);
    });
  }

  it("never lets a nested symbol wear a top-level export's path", () => {
    // Every shape above whose declaration is nested, with a top-level export
    // of the same bare name added beside it. The nested symbol's path must
    // differ from the export's, on both sides — that difference is the whole
    // mechanism that keeps `foldReach` from crossing them. Names that are not
    // identifiers are excluded: no export can be declared as `#unlock` or
    // `get value`, so the fixture this loop builds would not parse — which is
    // also why those names cannot collide with an export in the first place.
    for (const shape of SHAPES.filter(
      (s) => s.path !== s.name && /^[A-Za-z_$][\w$]*$/.test(s.name),
    )) {
      const src = `${shape.src}export function ${shape.name}(a: string): string {
  return a;
}
`;
      const guard = collectGuards("a.ts", src).find((g) => g.signature.startsWith("if"));
      expect(guard!.qualifiedOwner, shape.what).not.toBe(shape.name);
      expect(guard!.qualifiedOwner, shape.what).toBe(shape.path);

      const symbols = mapSymbols("a.ts", src, src, wholeFile(src));
      const nested = symbols.filter((s) => s.qualifiedName === shape.path);
      expect(nested.length, shape.what).toBe(1);
      expect(nested[0].exported, shape.what).toBe(false);
      const exported = symbols.find((s) => s.qualifiedName === shape.name)!;
      expect(exported.exported, shape.what).toBe(true);
      expect(exported.kind, shape.what).toBe("function");
    }
  });

  it("keeps top-level code under the module sentinel, which no declaration can wear", () => {
    const src = `if (!process.env.TOKEN) {
  throw new Error("missing env");
}
export function noop(): void {}
`;
    const guards = collectGuards("a.ts", src);
    expect(guards.every((g) => g.qualifiedOwner === MODULE_OWNER)).toBe(true);
    const symbols = mapSymbols("a.ts", src, src, wholeFile(src));
    expect(symbols.map((s) => s.qualifiedName)).not.toContain(MODULE_OWNER);
  });

  it("roots a binding declared in a for header locally, not at the file", () => {
    // A `for` *body* is a block and was always covered. A header is neither a
    // block nor a frame, so `atFileTopLevel` walked through it and rooted the
    // binding at the file, where it wore the export's name — a `verified` guard
    // finding against an untouched export in one direction, and silence in the
    // other.
    //
    // Only the three-clause form can produce this: `for...in` and `for...of`
    // bind their name to an element rather than to an initializer, so nothing
    // in their headers can be a named function with a guard in it. Both are in
    // `isUnnamedScope` anyway, for completeness rather than for a case anyone
    // has found — which is why this test pins the form that discriminates and
    // does not pretend the other two do.
    const src = `for (const run = (x: number): number => {
  if (x < 0) {
    throw new Error("neg");
  }
  return x;
}; false; ) {
  void run;
}
export function run(a: string): string {
  return a;
}
`;
    const guard = collectGuards("a.ts", src).find((g) => g.signature.startsWith("if"))!;
    expect(guard.qualifiedOwner).toBe(`${LOCAL_SCOPE}.run`);

    const symbols = mapSymbols("a.ts", src, src, wholeFile(src));
    const exported = symbols.find((s) => s.qualifiedName === "run")!;
    expect(exported.kind).toBe("function");
    expect(exported.exported).toBe(true);
  });

  it("keeps a static-block local off the path of a static method with the same name", () => {
    // The p2/p2b break: a static block is a statement scope inside a *named*
    // frame, and the local root used to fire only on an empty frame stack —
    // so the block-local `helper` wore `Registry.helper`, the static method's
    // path, and a guard moved between the two cancelled to silence while a
    // guard removed from the local alone was reported against the method.
    const src = `export class Registry {
  static helper(x: number): number {
    if (x < 0) {
      throw new Error("negative");
    }
    return x;
  }
  static {
    const helper = (x: number): number => {
      if (x === 0) {
        throw new Error("zero");
      }
      return x;
    };
    void helper;
  }
}
`;
    const guards = collectGuards("a.ts", src).filter((g) => g.signature.startsWith("if"));
    const owners = guards.map((g) => g.qualifiedOwner);
    expect(owners).toContain("Registry.helper");
    expect(owners).toContain(`Registry.${LOCAL_SCOPE}.helper`);

    const symbols = mapSymbols("a.ts", src, src, wholeFile(src));
    const paths = symbols.map((s) => s.qualifiedName);
    expect(paths).toContain("Registry.helper");
    expect(paths).toContain(`Registry.${LOCAL_SCOPE}.helper`);
  });

  it("keeps a function-local object's method off the path of a merged namespace's real export", () => {
    // The p4 break: `function api` merged with `namespace api` share the
    // frame `api`, and a function-local `handlers.run` used to be qualified
    // `api.handlers.run` — the *genuinely exported* namespace member's path —
    // so the export's guard removal cancelled against the local's addition.
    const src = `export function api(y: number): number {
  const handlers = {
    run(v: number): number {
      if (v > 10) {
        throw new Error("too big");
      }
      return v;
    },
  };
  return handlers.run(y);
}
export namespace api {
  export const handlers = {
    run(v: number): number {
      if (v < 0) {
        throw new Error("negative");
      }
      return v;
    },
  };
}
`;
    const guards = collectGuards("a.ts", src).filter((g) => g.signature.startsWith("if"));
    const owners = guards.map((g) => g.qualifiedOwner);
    expect(owners).toContain(`api.${LOCAL_SCOPE}.handlers.run`);
    expect(owners).toContain("api.handlers.run");

    const symbols = mapSymbols("a.ts", src, src, wholeFile(src));
    const paths = symbols.map((s) => s.qualifiedName);
    expect(paths).toContain(`api.${LOCAL_SCOPE}.handlers.run`);
    expect(paths).toContain("api.handlers.run");
  });

  it("still attributes a guard sitting directly in a static block to the class itself", () => {
    // The local root is about *names declared* in a statement scope. A guard
    // that just runs there belongs to the class, exactly as
    // `test/analyze/guards.test.ts`, "attributes a static initializer block's
    // guard to the class", pins end-to-end.
    const src = `export class Boot {
  static {
    if (!process.env.TOKEN) {
      throw new Error("missing env");
    }
  }
}
`;
    const guards = collectGuards("a.ts", src);
    expect(guards.length).toBeGreaterThan(0);
    expect(guards.every((g) => g.qualifiedOwner === "Boot")).toBe(true);
  });

  it("keeps a private method's guard off the path of a computed-key sibling", () => {
    // The p8 break: `frameNameOf` demanded an Identifier for a method name,
    // so a `PrivateIdentifier` fell through to `<anonymous>` — `Vault.#unlock`
    // and `Vault.[k]` shared one path, and a guard moved between them
    // cancelled. A `#name` is spelled in full at the declaration and cannot
    // collide with any identifier, so throwing it away bought nothing.
    const src = `const k = "open";
export class Vault {
  #unlock(pin: string): string {
    if (pin.length < 4) {
      throw new Error("short");
    }
    return pin;
  }
  [k](pin: string): string {
    return pin;
  }
  use(pin: string): string {
    return this.#unlock(pin);
  }
}
`;
    const guard = collectGuards("a.ts", src).find((g) => g.signature.startsWith("if"))!;
    expect(guard.qualifiedOwner).toBe("Vault.#unlock");
  });

  it("gives a getter and a setter of one name two distinct paths", () => {
    // The getter/setter break: both accessors framed the bare `value`, so `Config.value`
    // was one path for two runtime symbols and a guard moved getter-to-setter
    // cancelled to silence — the check really did stop running on reads.
    const src = `export class Config {
  private _v = "x";
  get value(): string {
    if (this._v === "") {
      throw new Error("unset");
    }
    return this._v;
  }
  set value(v: string) {
    if (v === "x") {
      throw new Error("placeholder");
    }
    this._v = v;
  }
}
`;
    const owners = collectGuards("a.ts", src)
      .filter((g) => g.signature.startsWith("if"))
      .map((g) => g.qualifiedOwner);
    expect(owners).toContain(`Config.${GETTER_FRAME_PREFIX}value`);
    expect(owners).toContain(`Config.${SETTER_FRAME_PREFIX}value`);

    const paths = mapSymbols("a.ts", src, src, wholeFile(src)).map((s) => s.qualifiedName);
    expect(paths).toContain(`Config.${GETTER_FRAME_PREFIX}value`);
    expect(paths).toContain(`Config.${SETTER_FRAME_PREFIX}value`);
  });

  it("frames an anonymous default-export function as 'default', like an anonymous default class", () => {
    // A nameless function declaration is only legal as `export default
    // function`, exactly as a nameless class declaration is — the module's
    // principal export is nameable in both cases, and `default` is the name
    // it is exported under.
    const src = `export default function (req: string): string {
  if (req === "") {
    throw new Error("empty");
  }
  return req;
}
`;
    const guard = collectGuards("a.ts", src).find((g) => g.signature.startsWith("if"))!;
    expect(guard.qualifiedOwner).toBe("default");
  });

  it("frames an object literal that has no name to be known by", () => {
    const src = `register({
  run(x: number): number {
    if (x < 0) {
      throw new Error("negative");
    }
    return x;
  },
});
`;
    const guard = collectGuards("a.ts", src).find((g) => g.signature.startsWith("if"))!;
    expect(guard.qualifiedOwner).toBe(`${ANONYMOUS_OWNER}.run`);
    const symbols = mapSymbols("a.ts", src, src, wholeFile(src));
    expect(symbols.map((s) => s.qualifiedName)).toContain(`${ANONYMOUS_OWNER}.run`);
  });
});
