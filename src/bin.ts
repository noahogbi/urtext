#!/usr/bin/env node
import { main } from "./cli.js";

// The executable entry, and nothing else: it runs unconditionally. Its
// predecessor was an am-I-the-entry-module guard at the bottom of cli.ts
// comparing `process.argv[1]` against `import.meta.url`, and that comparison
// broke twice — once on the compiled filename, then under a symlinked global
// bin directory (fnm's, but any version manager or `npm link` does this),
// where Node resolves the real path for `import.meta.url` while `argv[1]`
// keeps the symlinked spelling. The guard failing means the CLI exits zero
// having printed nothing. Tests import cli.ts, which no longer self-runs;
// nothing imports this file.
void main();
