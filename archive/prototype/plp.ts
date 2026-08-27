// ============================================================
// KLAR-IR Presentation Layer Protocol (PLP)
// Projects the semantic graph into human-consumable formats.
// The human reads these. The AI works in the graph.
// ============================================================

import { KlarGraph, KlarType, ModelDef, RouteDef, MiddlewareDef, Field, Constraint, Effect } from "./types.js";
import { HandlerStep } from "./builder.js";

export type ProjectionMode = "pseudocode" | "natural" | "constraint" | "flowchart" | "api_surface" | "diff";

// --- Main projection entry ---
export function project(
  graph: KlarGraph & { _routes: any[]; _middleware: any[] },
  mode: ProjectionMode
): string {
  switch (mode) {
    case "pseudocode":  return projectPseudocode(graph);
    case "natural":     return projectNatural(graph);
    case "constraint":  return projectConstraints(graph);
    case "flowchart":   return projectFlowchart(graph);
    case "api_surface": return projectAPISurface(graph);
    case "diff":        return projectDiff(graph);
  }
}

// ── PSEUDOCODE ──────────────────────────────────────────────

function projectPseudocode(graph: KlarGraph & { _routes: any[] }): string {
  const lines: string[] = [];

  lines.push(`# ${graph.name}`);
  lines.push(`# Pseudocode projection from KLAR-IR`);
  lines.push("");

  // Models
  for (const [name, model] of graph.models) {
    lines.push(`model ${name}:`);
    for (const f of model.fields) {
      const constraints = f.constraints.length
        ? ` where ${f.constraints.map(c => constraintToReadable(c)).join(", ")}`
        : "";
      lines.push(`  ${f.name}: ${typeToReadable(f.type)}${constraints}`);
    }
    if (model.indexes?.length) {
      for (const idx of model.indexes) {
        lines.push(`  index(${idx.fields.join(", ")})${idx.unique ? " unique" : ""}`);
      }
    }
    lines.push("");
  }

  // Routes
  for (const route of graph._routes) {
    const inputs = formatInputs(route);
    lines.push(`route ${route.method} ${route.path}${inputs}:`);

    if (route.effects.length) {
      lines.push(`  effects: ${route.effects.map((e: Effect) => e.kind).join(", ")}`);
    }

    // Handler logic
    for (const step of (route as any)._handlerLogic) {
      lines.push(`  ${stepToPseudocode(step)}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

function stepToPseudocode(step: HandlerStep): string {
  const d = step.detail;
  switch (step.action) {
    case "validate":     return `validate ${d.field}: ${d.check}`;
    case "db_query":     return `${d.model} = db.${d.operation}(${d.model}${d.where ? `, where: ${JSON.stringify(d.where)}` : ""})`;
    case "db_insert":    return `record = db.insert(${d.model}, ${d.data || "body"})`;
    case "db_update":    return `db.update(${d.model}, where: ${JSON.stringify(d.where)}, data: ${d.data || "body"})`;
    case "db_delete":    return `db.delete(${d.model}, where: ${JSON.stringify(d.where)})`;
    case "hash":         return `${d.field} = hash(${d.field}, ${d.algorithm})`;
    case "compare_hash": return `assert hash_matches(${d.input}, ${d.stored})`;
    case "sign_token":   return `token = sign_jwt(${JSON.stringify(d.payload)}, expires: ${d.expiresIn})`;
    case "respond":      return `→ respond ${d.status}: ${d.body}`;
    case "respond_error": return `→ respond ${d.status}: error("${d.message}")`;
    case "branch":       return `if ${d.condition}: ...`;
    default:             return `${step.action}(${JSON.stringify(d)})`;
  }
}

// ── NATURAL LANGUAGE ────────────────────────────────────────

function projectNatural(graph: KlarGraph & { _routes: any[]; _middleware: any[] }): string {
  const lines: string[] = [];

  lines.push(`## ${graph.name}`);
  lines.push("");
  lines.push(`This application is a web server running on port ${graph.config.port}.`);
  lines.push("");

  // Data models
  lines.push("### Data Models");
  lines.push("");
  for (const [name, model] of graph.models) {
    const fieldDescs = model.fields.map(f => {
      let desc = `**${f.name}** (${typeToReadable(f.type)})`;
      if (f.constraints.length) {
        desc += ` — ${f.constraints.map(c => c.message).join("; ")}`;
      }
      return desc;
    });
    lines.push(`A **${name}** has: ${fieldDescs.join(", ")}.`);

    if (model.indexes?.length) {
      const idxDescs = model.indexes.map(i =>
        `${i.unique ? "unique " : ""}index on ${i.fields.join(" + ")}`
      );
      lines.push(`Indexed by: ${idxDescs.join(", ")}.`);
    }
    lines.push("");
  }

  // Middleware
  if (graph._middleware.length) {
    lines.push("### Middleware Pipeline");
    lines.push("");
    const sorted = [...graph._middleware].sort((a, b) => a.order - b.order);
    for (const mw of sorted) {
      lines.push(`${mw.order}. **${mw.name}**: ${middlewareToNatural(mw)}`);
    }
    lines.push("");
  }

  // Routes
  lines.push("### API Endpoints");
  lines.push("");
  for (const route of graph._routes) {
    lines.push(`**${route.method} ${route.path}**`);
    lines.push(routeToNatural(route));
    if (route.proofs.length) {
      lines.push(`*Verified properties:* ${route.proofs.map((p: any) => p.property).join(", ")}.`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function middlewareToNatural(mw: MiddlewareDef & { _type?: string }): string {
  switch ((mw as any)._type) {
    case "rate_limit":
      return `Limits clients to ${mw.config.maxRequests} requests per ${mw.config.windowMs / 1000} seconds.`;
    case "jwt_auth":
      return `Requires a valid JWT token in the Authorization header.`;
    case "logger":
      return `Logs every request with method, path, status, and response time.`;
    case "cors":
      return `Allows cross-origin requests from: ${(mw.config.origins || ["*"]).join(", ")}.`;
    default:
      return `Custom middleware.`;
  }
}

function routeToNatural(route: RouteDef & { _handlerLogic: HandlerStep[] }): string {
  const steps = route._handlerLogic;
  const parts: string[] = [];

  for (const step of steps) {
    const d = step.detail;
    switch (step.action) {
      case "validate":
        parts.push(`Validates that ${d.field} meets the requirement: ${d.check}`);
        break;
      case "db_query":
        if (d.operation === "findOne") {
          parts.push(`Looks up a ${d.model} from the database`);
        } else {
          parts.push(`Retrieves ${d.model} records from the database`);
        }
        break;
      case "db_insert":
        parts.push(`Creates a new ${d.model} record`);
        break;
      case "db_update":
        parts.push(`Updates the ${d.model} record`);
        break;
      case "db_delete":
        parts.push(`Deletes the ${d.model} record`);
        break;
      case "hash":
        parts.push(`Securely hashes the ${d.field} using ${d.algorithm}`);
        break;
      case "compare_hash":
        parts.push(`Verifies the provided credentials against stored hash`);
        break;
      case "sign_token":
        parts.push(`Issues a JWT token (valid for ${d.expiresIn})`);
        break;
      case "respond":
        parts.push(`Returns the result with status ${d.status}`);
        break;
      case "respond_error":
        parts.push(`Returns an error: "${d.message}" (${d.status})`);
        break;
    }
  }

  return parts.join(". ") + ".";
}

// ── CONSTRAINT VIEW ─────────────────────────────────────────

function projectConstraints(graph: KlarGraph & { _routes: any[] }): string {
  const lines: string[] = [];

  lines.push("╔══════════════════════════════════════════╗");
  lines.push("║       KLAR-IR CONSTRAINT MANIFEST        ║");
  lines.push("╚══════════════════════════════════════════╝");
  lines.push("");

  // Model constraints
  lines.push("── MODEL INVARIANTS ──");
  for (const [name, model] of graph.models) {
    lines.push("");
    lines.push(`  ${name}:`);
    for (const f of model.fields) {
      const typeLine = `    ${f.name}: ${typeToReadable(f.type)}`;
      lines.push(typeLine);
      for (const c of f.constraints) {
        lines.push(`      ├─ ${c.op}: ${constraintToReadable(c)}`);
        lines.push(`      │  enforcement: ${c.enforcement}`);
      }
    }
  }
  lines.push("");

  // Route constraints & effects
  lines.push("── ROUTE CONTRACTS ──");
  for (const route of graph._routes) {
    lines.push("");
    lines.push(`  ${route.method} ${route.path}`);

    // Inputs
    const allInputs = [
      ...(route.input.params || []).map((f: Field) => ({ ...f, source: "param" })),
      ...(route.input.query || []).map((f: Field) => ({ ...f, source: "query" })),
      ...(route.input.body || []).map((f: Field) => ({ ...f, source: "body" })),
    ];

    if (allInputs.length) {
      lines.push("    INPUTS:");
      for (const input of allInputs) {
        lines.push(`      ${input.name}: ${typeToReadable(input.type)} [${input.source}]`);
        for (const c of input.constraints) {
          lines.push(`        └─ ${constraintToReadable(c)}`);
        }
      }
    }

    // Effects
    if (route.effects.length) {
      lines.push(`    EFFECTS:`);
      for (const e of route.effects) {
        lines.push(`      └─ ${e.kind}${e.detail ? `: ${e.detail}` : ""}`);
      }
    }

    // Proofs
    if (route.proofs.length) {
      lines.push(`    PROOFS:`);
      for (const p of route.proofs) {
        lines.push(`      ✓ ${p.property}: ${p.detail} [${p.kind}]`);
      }
    } else {
      lines.push(`    PROOFS: ⚠ none`);
    }

    // Output
    lines.push(`    OUTPUT: ${typeToReadable(route.output)}`);
  }

  return lines.join("\n");
}

// ── FLOWCHART (Mermaid) ─────────────────────────────────────

function projectFlowchart(graph: KlarGraph & { _routes: any[] }): string {
  const lines: string[] = [];

  lines.push("```mermaid");
  lines.push("graph TD");
  lines.push("  Client([Client])");
  lines.push("");

  // Middleware chain
  const sortedMw = [...graph.middleware].sort((a, b) => a.order - b.order);
  let prevNode = "Client";
  for (const mw of sortedMw) {
    const nodeId = `MW_${mw.name}`;
    lines.push(`  ${nodeId}[${mw.name}]`);
    lines.push(`  ${prevNode} --> ${nodeId}`);
    prevNode = nodeId;
  }

  // Router
  lines.push(`  Router{Router}`);
  lines.push(`  ${prevNode} --> Router`);
  lines.push("");

  // Routes
  for (const route of graph._routes) {
    const routeId = `R_${route.method}_${route.path.replace(/[/:]/g, "_")}`;
    lines.push(`  ${routeId}["${route.method} ${route.path}"]`);
    lines.push(`  Router --> ${routeId}`);

    // Show DB effects
    const dbEffects = route.effects.filter((e: Effect) => e.kind === "DB");
    if (dbEffects.length) {
      const dbId = `DB_${routeId}`;
      lines.push(`  ${dbId}[(Database)]`);
      lines.push(`  ${routeId} --> ${dbId}`);
    }
  }

  lines.push("```");
  return lines.join("\n");
}

// ── API SURFACE ─────────────────────────────────────────────

function projectAPISurface(graph: KlarGraph & { _routes: any[] }): string {
  const lines: string[] = [];

  lines.push(`# ${graph.name} — API Reference`);
  lines.push("");
  lines.push(`Base URL: http://localhost:${graph.config.port}`);
  lines.push("");

  lines.push("## Endpoints");
  lines.push("");

  for (const route of graph._routes) {
    lines.push(`### \`${route.method} ${route.path}\``);
    lines.push("");
    lines.push(route.provenance.instruction);
    lines.push("");

    // Request
    if (route.input.body?.length) {
      lines.push("**Request Body:**");
      lines.push("```json");
      const body: Record<string, string> = {};
      for (const f of route.input.body) {
        body[f.name] = typeToReadable(f.type);
      }
      lines.push(JSON.stringify(body, null, 2));
      lines.push("```");
      lines.push("");
    }

    if (route.input.params?.length) {
      lines.push("**Path Parameters:**");
      for (const p of route.input.params) {
        lines.push(`- \`${p.name}\`: ${typeToReadable(p.type)}`);
      }
      lines.push("");
    }

    if (route.input.query?.length) {
      lines.push("**Query Parameters:**");
      for (const q of route.input.query) {
        lines.push(`- \`${q.name}\`: ${typeToReadable(q.type)}`);
      }
      lines.push("");
    }

    // Response
    lines.push(`**Response:** ${typeToReadable(route.output)}`);
    lines.push("");

    // Auth
    const authMw = graph.middleware.find(m => route.middleware.includes(m.id));
    if (authMw) {
      lines.push("**Authentication:** Required (Bearer token)");
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ── DIFF VIEW ───────────────────────────────────────────────

function projectDiff(graph: KlarGraph): string {
  const lines: string[] = [];

  lines.push("╔══════════════════════════════════════════╗");
  lines.push("║          KLAR-IR CHANGE JOURNAL          ║");
  lines.push("╚══════════════════════════════════════════╝");
  lines.push("");

  for (const entry of graph.journal) {
    lines.push(`  [${entry.timestamp}] ${entry.op.kind}`);
    lines.push(`    Reason: ${entry.reason}`);

    switch (entry.op.kind) {
      case "AddModel":
        lines.push(`    + Model: ${entry.op.model.name} (${entry.op.model.fields.length} fields)`);
        break;
      case "AddRoute":
        lines.push(`    + Route: ${entry.op.route.method} ${entry.op.route.path}`);
        break;
      case "AddMiddleware":
        lines.push(`    + Middleware: ${entry.op.middleware.name} (order: ${entry.op.middleware.order})`);
        break;
      case "PropagateField":
        lines.push(`    ⟳ Propagate: ${entry.op.model}.${entry.op.field.name}: ${typeToReadable(entry.op.field.type)}`);
        lines.push(`      This operation updates all constructors, destructors, and serializers.`);
        break;
      case "AddNode":
        lines.push(`    + Node: ${entry.op.node.kind} "${entry.op.node.label}"`);
        break;
      case "RemoveNode":
        lines.push(`    - Node: ${entry.op.nodeId}`);
        break;
      default:
        lines.push(`    ${JSON.stringify(entry.op)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Helpers ─────────────────────────────────────────────────

function typeToReadable(type: KlarType): string {
  switch (type.kind) {
    case "primitive": return type.name;
    case "option": return `${typeToReadable(type.inner)}?`;
    case "result": return `Result<${typeToReadable(type.ok)}, ${typeToReadable(type.err)}>`;
    case "array": return `[${typeToReadable(type.element)}]`;
    case "map": return `{${typeToReadable(type.key)}: ${typeToReadable(type.value)}}`;
    case "ref": return type.structName;
    case "union": return type.variants.map(v => v.tag).join(" | ");
    case "refined": return `${typeToReadable(type.base)} where ${type.constraint.message}`;
    default: return "unknown";
  }
}

function constraintToReadable(c: Constraint): string {
  switch (c.op) {
    case "matches": return `matches /${c.pattern}/`;
    case "length_between": {
      if (c.min !== undefined && c.max !== undefined) return `length ${c.min}..${c.max}`;
      if (c.min !== undefined) return `length >= ${c.min}`;
      if (c.max !== undefined) return `length <= ${c.max}`;
      return "length constrained";
    }
    case "in": return `one of ${JSON.stringify(c.value)}`;
    default: return `${c.op} ${c.value ?? ""}`;
  }
}

function formatInputs(route: RouteDef): string {
  const parts: string[] = [];
  if (route.input.body?.length) {
    parts.push(route.input.body.map(f => `${f.name}: ${typeToReadable(f.type)}`).join(", "));
  }
  if (route.input.params?.length) {
    parts.push(route.input.params.map(f => `${f.name}: ${typeToReadable(f.type)}`).join(", "));
  }
  return parts.length ? `(${parts.join(", ")})` : "";
}
