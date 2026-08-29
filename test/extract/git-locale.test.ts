import { describe, expect, it, vi } from "vitest";
import { git } from "../../src/extract/git.js";

// This suite verifies the *mechanism* behind locale-independent absence
// detection: that git() always pins LC_ALL/LANGUAGE to "C" when it spawns
// git, regardless of the caller's environment. We can't reliably assert on
// translated stderr text end-to-end — that would require a git build with
// NLS message catalogs installed for a specific locale, which this machine
// may not have, and a test that silently no-ops when catalogs are absent
// would be dishonest. Asserting on the exact options passed to execFile is
// the honest, environment-independent way to cover this behavior.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

execFileMock.mockImplementation(
  (
    _file: string,
    _args: string[],
    _options: Record<string, unknown>,
    callback: (err: null, result: { stdout: string; stderr: string }) => void,
  ) => {
    callback(null, { stdout: "", stderr: "" });
  },
);

describe("git()", () => {
  it("pins LC_ALL and LANGUAGE to C on every invocation so isAbsenceError's stderr matching does not depend on the caller's locale", async () => {
    await git(["status"], "C:/wherever");

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const options = execFileMock.mock.calls[0]?.[2] as
      | { env?: Record<string, unknown> }
      | undefined;
    expect(options?.env).toMatchObject({ LC_ALL: "C", LANGUAGE: "C" });
  });

  it("still forwards the caller's other environment variables", async () => {
    process.env.URTEXT_TEST_MARKER = "present";
    try {
      await git(["status"], "C:/wherever");
      const options = execFileMock.mock.calls.at(-1)?.[2] as
        | { env?: Record<string, unknown> }
        | undefined;
      expect(options?.env).toMatchObject({
        URTEXT_TEST_MARKER: "present",
      });
    } finally {
      delete process.env.URTEXT_TEST_MARKER;
    }
  });
});
