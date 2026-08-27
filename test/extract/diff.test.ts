import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../src/extract/diff.js";

const MODIFIED = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,2 +10,3 @@ export function a() {
-  const x = 1;
+  const x = 2;
+  const y = 3;
@@ -40,0 +41,1 @@
+  console.log("hi");
`;

const ADDED = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const n = 1;
+
`;

const DELETED = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-export const o = 1;
`;

const RENAMED = `diff --git a/src/from.ts b/src/to.ts
similarity index 92%
rename from src/from.ts
rename to src/to.ts
index 5555555..6666666 100644
--- a/src/from.ts
+++ b/src/to.ts
@@ -3 +3 @@
-const q = 1;
+const q = 2;
`;

describe("parseUnifiedDiff", () => {
  it("parses a modified file with multiple hunks", () => {
    const files = parseUnifiedDiff(MODIFIED);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/a.ts");
    expect(files[0].status).toBe("modified");
    expect(files[0].hunks).toEqual([
      { oldStart: 10, oldLines: 2, newStart: 10, newLines: 3 },
      { oldStart: 40, oldLines: 0, newStart: 41, newLines: 1 },
    ]);
  });

  it("defaults an omitted line count to 1", () => {
    const files = parseUnifiedDiff(RENAMED);
    expect(files[0].hunks).toEqual([
      { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 },
    ]);
  });

  it("marks added files", () => {
    const files = parseUnifiedDiff(ADDED);
    expect(files[0].status).toBe("added");
    expect(files[0].path).toBe("src/new.ts");
  });

  it("marks deleted files", () => {
    const files = parseUnifiedDiff(DELETED);
    expect(files[0].status).toBe("deleted");
    expect(files[0].path).toBe("src/old.ts");
  });

  it("marks renamed files and records the previous path", () => {
    const files = parseUnifiedDiff(RENAMED);
    expect(files[0].status).toBe("renamed");
    expect(files[0].path).toBe("src/to.ts");
    expect(files[0].previousPath).toBe("src/from.ts");
  });

  it("parses several files in one diff", () => {
    const files = parseUnifiedDiff(MODIFIED + ADDED + DELETED);
    expect(files.map((f) => f.path)).toEqual([
      "src/a.ts",
      "src/new.ts",
      "src/old.ts",
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("skips a file entry whose header cannot be read rather than naming nothing", () => {
    // A quoted path (git's core.quotePath default) is the case that produced
    // this: an entry with an empty path sent readAt at the repository root.
    const QUOTED = `diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"
new file mode 100644
--- /dev/null
+++ "b/caf\\303\\251.ts"
@@ -0,0 +1,1 @@
+export const c = 1;
`;
    const files = parseUnifiedDiff(QUOTED + ADDED);
    expect(files.map((f) => f.path)).toEqual(["src/new.ts"]);
    expect(files.every((f) => f.path !== "")).toBe(true);
  });

  it("does not attach an unreadable entry's hunks to the previous file", () => {
    const files = parseUnifiedDiff(
      ADDED + `diff --git "a/x y.ts" "b/x y.ts"\n@@ -1,5 +1,5 @@\n`,
    );
    expect(files).toHaveLength(1);
    expect(files[0].hunks).toHaveLength(1);
  });
});
