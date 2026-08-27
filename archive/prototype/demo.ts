#!/usr/bin/env tsx
// ============================================================
// KLAR-IR Demo: Build a real API in the semantic graph,
// then emit a working server.ts and all PLP projections.
//
// Run: npx tsx src/demo.ts
// ============================================================

import { klar, MiddlewareBuilder } from "./builder.js";
import { T } from "./types.js";
import { check, formatCheckResult } from "./checker.js";
import { emit } from "./emit-ts.js";
import { project, ProjectionMode } from "./plp.js";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// ── Build the graph ─────────────────────────────────────────

console.log("\n🔷 KLAR-IR Prototype — Building semantic graph...\n");

const authMiddleware = MiddlewareBuilder.auth();
const authMwId = authMiddleware.id;

const graph = klar("UserAuthAPI")

  // ── Configuration ──
  .config({
    port: 3000,
    host: "0.0.0.0",
    cors: { origins: ["http://localhost:5173"], methods: ["GET", "POST", "PUT", "DELETE"] },
    rateLimit: { windowMs: 60_000, maxRequests: 100 },
  })

  // ── Middleware ──
  .middleware(MiddlewareBuilder.cors(["http://localhost:5173"]))
  .middleware(MiddlewareBuilder.logger(1))
  .middleware(MiddlewareBuilder.rateLimit(60_000, 100, 10))
  .middleware(authMiddleware)

  // ── Models ──
  .model("User", m => m
    .id()
    .field("email", T.str, f => f
      .matches("^[^@]+@[^@]+\\.[^@]+$", "Must be a valid email address")
      .notEmpty()
    )
    .field("name", T.str, f => f
      .minLength(2, "Name must be at least 2 characters")
      .maxLength(100, "Name must be at most 100 characters")
    )
    .field("password", T.str, f => f
      .minLength(8, "Password must be at least 8 characters")
    )
    .field("role", T.str, f => f
      .constraint("in", ["user", "admin"], "Role must be 'user' or 'admin'")
      .default("user")
    )
    .timestamps()
    .uniqueIndex("email")
  )

  .model("Post", m => m
    .id()
    .field("title", T.str, f => f
      .notEmpty("Title is required")
      .maxLength(200, "Title must be under 200 characters")
    )
    .field("body", T.str, f => f.notEmpty("Post body is required"))
    .field("authorId", T.str, f => f.notEmpty("Author ID is required"))
    .field("published", T.bool, f => f.default(false))
    .timestamps()
  )

  // ── Routes ──

  // Register
  .route("POST", "/auth/register", r => r
    .describe("Register a new user account")
    .body("email", T.str, f => f.matches("^[^@]+@[^@]+\\.[^@]+$", "Valid email required"))
    .body("name", T.str, f => f.minLength(2))
    .body("password", T.str, f => f.minLength(8, "Password must be at least 8 characters"))
    .returns(T.ref("User"))
    .dbQuery("findOne", "User", { email: "$body.email" })
    .step("branch", {
      condition: "found",
      then: [{ id: "s1", action: "respond_error", detail: { status: 409, message: "Email already registered" } }],
    })
    .hashField("password")
    .dbInsert("User")
    .respond(201, "{ id: record.id, email: record.email, name: record.name, role: record.role }")
    .proof("no_plaintext_password", "by_construction", "Password is hashed before storage via bcrypt")
    .proof("unique_email", "by_constraint", "Email uniqueness enforced by DB index + pre-check")
  )

  // Login
  .route("POST", "/auth/login", r => r
    .describe("Authenticate and receive a JWT token")
    .body("email", T.str)
    .body("password", T.str)
    .returns(T.ref("Token"))
    .dbQuery("findOne", "User", { email: "$body.email" })
    .step("branch", {
      condition: "!found",
      then: [{ id: "s2", action: "respond_error", detail: { status: 401, message: "Invalid credentials" } }],
    })
    .compareHash("body.password", "found.password")
    .signToken({ sub: "$found.id", email: "$found.email", role: "$found.role" }, "24h")
    .respond(200, `{ token, user: { id: found.id, email: found.email, name: found.name, role: found.role } }`)
    .proof("timing_safe", "by_construction", "Hash comparison is constant-time via bcrypt.compare")
  )

  // Get current user
  .route("GET", "/users/me", r => r
    .describe("Get the currently authenticated user's profile")
    .uses(authMwId)
    .returns(T.ref("User"))
    .dbQuery("findOne", "User", { id: "$c.get('user').sub" })
    .step("branch", {
      condition: "!found",
      then: [{ id: "s3", action: "respond_error", detail: { status: 404, message: "User not found" } }],
    })
    .respond(200, "{ id: found.id, email: found.email, name: found.name, role: found.role }")
    .proof("auth_required", "by_constraint", "JWT middleware validates token before handler executes")
    .proof("no_password_leak", "by_construction", "Response explicitly excludes password field")
  )

  // List posts
  .route("GET", "/posts", r => r
    .describe("List all published posts")
    .returns(T.array(T.ref("Post")))
    .dbQuery("findMany", "Post")
    .respond(200, "results.filter(p => p.published)")
  )

  // Create post
  .route("POST", "/posts", r => r
    .describe("Create a new post (authenticated)")
    .uses(authMwId)
    .body("title", T.str, f => f.notEmpty().maxLength(200))
    .body("body", T.str, f => f.notEmpty())
    .returns(T.ref("Post"))
    .dbInsert("Post", "{ ...body, authorId: c.get('user').sub, published: false }")
    .respond(201, "record")
    .proof("auth_required", "by_constraint", "JWT middleware validates token before handler executes")
    .proof("author_binding", "by_construction", "authorId is set from JWT payload, not user input")
  )

  // Get post by ID
  .route("GET", "/posts/:id", r => r
    .describe("Get a single post by ID")
    .param("id", T.str)
    .returns(T.ref("Post"))
    .dbQuery("findOne", "Post", { id: "$id" })
    .step("branch", {
      condition: "!found",
      then: [{ id: "s4", action: "respond_error", detail: { status: 404, message: "Post not found" } }],
    })
    .respond(200, "found")
  )

  // Delete post
  .route("DELETE", "/posts/:id", r => r
    .describe("Delete a post (authenticated, owner only)")
    .uses(authMwId)
    .param("id", T.str)
    .returns(T.void)
    .dbQuery("findOne", "Post", { id: "$id" })
    .step("branch", {
      condition: "!found",
      then: [{ id: "s5", action: "respond_error", detail: { status: 404, message: "Post not found" } }],
    })
    .step("branch", {
      condition: `found.authorId !== c.get('user').sub`,
      then: [{ id: "s6", action: "respond_error", detail: { status: 403, message: "Not authorized to delete this post" } }],
    })
    .dbDelete("Post", { id: "$id" })
    .respond(200, `{ message: "Post deleted" }`)
    .proof("auth_required", "by_constraint", "JWT middleware validates token")
    .proof("owner_only", "by_construction", "Handler checks authorId matches JWT subject before deletion")
  )

  .build();

// ── Check constraints ─────────────────────────────────────────

console.log("📋 Running constraint checker...\n");
const result = check(graph);
console.log(formatCheckResult(result));
console.log("");

// ── Emit server.ts ────────────────────────────────────────────

console.log("⚡ Transpiling to TypeScript...\n");
const serverCode = emit(graph);

const outDir = join(process.cwd(), "output");
mkdirSync(outDir, { recursive: true });

writeFileSync(join(outDir, "server.ts"), serverCode);
console.log(`  ✓ output/server.ts (${serverCode.split("\n").length} lines)`);

// ── Generate all PLP projections ──────────────────────────────

console.log("\n📊 Generating PLP projections...\n");

const modes: ProjectionMode[] = ["pseudocode", "natural", "constraint", "flowchart", "api_surface", "diff"];

for (const mode of modes) {
  const output = project(graph, mode);
  const ext = mode === "flowchart" ? "md" : mode === "api_surface" ? "md" : "txt";
  const filename = `projection-${mode}.${ext}`;
  writeFileSync(join(outDir, filename), output);
  console.log(`  ✓ output/${filename}`);
}

// ── Summary ───────────────────────────────────────────────────

console.log("\n═══════════════════════════════════════════════");
console.log("  KLAR-IR compilation complete.");
console.log("");
console.log("  Semantic graph → Constraint check → Transpile → Project");
console.log("");
console.log("  The AI reasoned in the graph.");
console.log("  The human reads the projections.");
console.log("  The server runs the TypeScript.");
console.log("═══════════════════════════════════════════════\n");

// ── Also output the raw IR for inspection ─────────────────────

const irDump = JSON.stringify({
  id: graph.id,
  name: graph.name,
  version: graph.version,
  config: graph.config,
  models: Object.fromEntries(graph.models),
  routes: graph.routes.map(r => ({
    id: r.id,
    method: r.method,
    path: r.path,
    effects: r.effects,
    constraints: r.constraints,
    proofs: r.proofs,
    input: r.input,
    output: r.output,
  })),
  middleware: graph.middleware.map(m => ({
    id: m.id,
    name: m.name,
    order: m.order,
    effects: m.effects,
    config: m.config,
  })),
  journal: graph.journal,
}, null, 2);

writeFileSync(join(outDir, "graph.json"), irDump);
console.log("  ✓ output/graph.json (raw IR for inspection)\n");
