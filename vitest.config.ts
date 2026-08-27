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
  },
});
