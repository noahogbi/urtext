import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Many suites here build real git repositories and construct type-checked
    // programs — seconds of subprocess work apiece that stretches further
    // under full-suite parallelism or CI load. Nothing in this project is
    // pace-tested, so the timeout exists only to catch a genuine hang.
    testTimeout: 60_000,
    // The same ceiling for hooks, and for the same reason: several suites do
    // that setup work in `beforeAll` rather than in the test body — building
    // a repository and running a whole review before the first assertion.
    // Vitest times hooks out separately, and its default sits far below the
    // ceiling above, so those suites failed intermittently under full-suite
    // parallelism while the work they do is identical.
    hookTimeout: 60_000,
  },
});
