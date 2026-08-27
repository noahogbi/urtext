// ============================================================
// KLAR-IR Constraint Checker
// Validates the semantic graph before emission.
// This is where "illegal states are unrepresentable" is enforced.
// ============================================================

import { KlarGraph, ModelDef, RouteDef, MiddlewareDef, Field, Constraint, Effect } from "./types.js";

export interface CheckResult {
  valid: boolean;
  errors: CheckError[];
  warnings: CheckWarning[];
  stats: CheckStats;
}

export interface CheckError {
  code: string;
  message: string;
  location: string;   // human-readable location in the graph
  nodeId?: string;
}

export interface CheckWarning {
  code: string;
  message: string;
  location: string;
  suggestion?: string;
}

export interface CheckStats {
  modelsChecked: number;
  routesChecked: number;
  constraintsVerified: number;
  effectsTracked: number;
  proofsPresent: number;
  proofsMissing: number;
}

export function check(graph: KlarGraph): CheckResult {
  const errors: CheckError[] = [];
  const warnings: CheckWarning[] = [];
  const stats: CheckStats = {
    modelsChecked: 0,
    routesChecked: 0,
    constraintsVerified: 0,
    effectsTracked: 0,
    proofsPresent: 0,
    proofsMissing: 0,
  };

  // --- Check models ---
  for (const [name, model] of graph.models) {
    stats.modelsChecked++;
    checkModel(name, model, errors, warnings, stats);
  }

  // --- Check routes ---
  for (const route of graph.routes) {
    stats.routesChecked++;
    checkRoute(route, graph, errors, warnings, stats);
  }

  // --- Check middleware ordering ---
  checkMiddlewareOrder(graph.middleware, warnings);

  // --- Check for orphan references ---
  checkOrphanRefs(graph, errors);

  // --- Check config ---
  checkConfig(graph.config, errors, warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats,
  };
}

function checkModel(name: string, model: ModelDef, errors: CheckError[], warnings: CheckWarning[], stats: CheckStats) {
  if (model.fields.length === 0) {
    errors.push({
      code: "MODEL_EMPTY",
      message: `Model '${name}' has no fields`,
      location: `model:${name}`,
      nodeId: model.id,
    });
  }

  // Check for duplicate field names
  const fieldNames = new Set<string>();
  for (const field of model.fields) {
    if (fieldNames.has(field.name)) {
      errors.push({
        code: "DUPLICATE_FIELD",
        message: `Model '${name}' has duplicate field '${field.name}'`,
        location: `model:${name}.${field.name}`,
        nodeId: model.id,
      });
    }
    fieldNames.add(field.name);

    // Verify constraints are well-formed
    for (const c of field.constraints) {
      stats.constraintsVerified++;
      checkConstraint(c, `model:${name}.${field.name}`, errors);
    }
  }

  // Check for id field
  if (!model.fields.some(f => f.name === "id")) {
    warnings.push({
      code: "NO_ID_FIELD",
      message: `Model '${name}' has no 'id' field`,
      location: `model:${name}`,
      suggestion: "Add .id() to the model builder",
    });
  }

  // Check indexes reference valid fields
  if (model.indexes) {
    for (const idx of model.indexes) {
      for (const f of idx.fields) {
        if (!fieldNames.has(f)) {
          errors.push({
            code: "INDEX_INVALID_FIELD",
            message: `Index on '${name}' references non-existent field '${f}'`,
            location: `model:${name}.index(${idx.fields.join(",")})`,
          });
        }
      }
    }
  }
}

function checkRoute(route: RouteDef, graph: KlarGraph, errors: CheckError[], warnings: CheckWarning[], stats: CheckStats) {
  const loc = `route:${route.method} ${route.path}`;

  // Check path params match declared params
  const pathParams = (route.path.match(/:([a-zA-Z_]+)/g) || []).map(p => p.slice(1));
  const declaredParams = (route.input.params || []).map(p => p.name);

  for (const pp of pathParams) {
    if (!declaredParams.includes(pp)) {
      errors.push({
        code: "UNDECLARED_PATH_PARAM",
        message: `Path '${route.path}' uses ':${pp}' but it's not declared in params`,
        location: loc,
        nodeId: route.id,
      });
    }
  }

  // Check body is only on methods that support it
  if (route.input.body?.length && (route.method === "GET" || route.method === "DELETE")) {
    warnings.push({
      code: "BODY_ON_GET",
      message: `${route.method} ${route.path} declares a request body, which is unconventional`,
      location: loc,
      suggestion: "Consider using query parameters instead",
    });
  }

  // Track effects
  for (const effect of route.effects) {
    stats.effectsTracked++;
  }

  // Check effects are declared for DB operations
  const routeAny = route as any;
  if (routeAny._handlerLogic) {
    const hasDbStep = routeAny._handlerLogic.some(
      (s: any) => s.action.startsWith("db_")
    );
    const hasDbEffect = route.effects.some(e => e.kind === "DB");
    if (hasDbStep && !hasDbEffect) {
      errors.push({
        code: "UNDECLARED_EFFECT",
        message: `Route performs DB operations but doesn't declare DB effect`,
        location: loc,
        nodeId: route.id,
      });
    }
  }

  // Check proofs
  if (route.proofs.length > 0) {
    stats.proofsPresent += route.proofs.length;
  } else {
    stats.proofsMissing++;
    warnings.push({
      code: "NO_PROOFS",
      message: `Route has no proof annotations`,
      location: loc,
      suggestion: "Add .proof() calls for correctness documentation",
    });
  }

  // Validate constraints on inputs
  for (const group of [route.input.params, route.input.query, route.input.body, route.input.headers]) {
    if (!group) continue;
    for (const field of group) {
      for (const c of field.constraints) {
        stats.constraintsVerified++;
        checkConstraint(c, `${loc}.${field.name}`, errors);
      }
    }
  }

  // Check middleware references exist
  for (const mwId of route.middleware) {
    if (!graph.middleware.some((m: any) => m.id === mwId)) {
      errors.push({
        code: "MISSING_MIDDLEWARE",
        message: `Route references middleware '${mwId}' which doesn't exist`,
        location: loc,
        nodeId: route.id,
      });
    }
  }
}

function checkConstraint(c: Constraint, location: string, errors: CheckError[]) {
  if (!c.message || c.message.trim() === "") {
    errors.push({
      code: "CONSTRAINT_NO_MESSAGE",
      message: `Constraint '${c.id}' at ${location} has no human-readable message`,
      location,
      nodeId: c.id,
    });
  }

  if (c.op === "matches" && !c.pattern) {
    errors.push({
      code: "CONSTRAINT_NO_PATTERN",
      message: `Regex constraint '${c.id}' at ${location} has no pattern`,
      location,
      nodeId: c.id,
    });
  }

  if (c.op === "length_between" && c.min === undefined && c.max === undefined) {
    errors.push({
      code: "CONSTRAINT_NO_BOUNDS",
      message: `Length constraint '${c.id}' at ${location} has neither min nor max`,
      location,
      nodeId: c.id,
    });
  }
}

function checkMiddlewareOrder(middleware: MiddlewareDef[], warnings: CheckWarning[]) {
  const sorted = [...middleware].sort((a, b) => a.order - b.order);
  const names = sorted.map(m => m.name);

  // Warn if auth comes before logger
  const loggerIdx = names.indexOf("logger");
  const authIdx = names.indexOf("auth");
  if (loggerIdx > -1 && authIdx > -1 && authIdx < loggerIdx) {
    warnings.push({
      code: "MIDDLEWARE_ORDER",
      message: "Auth middleware runs before logger — failed auth attempts won't be logged",
      location: "middleware:ordering",
      suggestion: "Set logger order lower than auth order",
    });
  }
}

function checkOrphanRefs(graph: KlarGraph, errors: CheckError[]) {
  const modelNames = new Set(graph.models.keys());

  for (const route of graph.routes) {
    const routeAny = route as any;
    if (routeAny._handlerLogic) {
      for (const step of routeAny._handlerLogic) {
        if (step.detail?.model && !modelNames.has(step.detail.model)) {
          errors.push({
            code: "ORPHAN_MODEL_REF",
            message: `Route '${route.method} ${route.path}' references model '${step.detail.model}' which doesn't exist`,
            location: `route:${route.method} ${route.path}`,
            nodeId: route.id,
          });
        }
      }
    }
  }
}

function checkConfig(config: any, errors: CheckError[], warnings: CheckWarning[]) {
  if (!config.port || config.port < 1 || config.port > 65535) {
    errors.push({
      code: "INVALID_PORT",
      message: `Port ${config.port} is invalid (must be 1-65535)`,
      location: "config:port",
    });
  }
}

// --- Formatted output ---
export function formatCheckResult(result: CheckResult): string {
  const lines: string[] = [];

  lines.push("╔══════════════════════════════════════════╗");
  lines.push("║         KLAR-IR CONSTRAINT CHECK         ║");
  lines.push("╚══════════════════════════════════════════╝");
  lines.push("");

  if (result.valid) {
    lines.push("  ✓ Graph is VALID");
  } else {
    lines.push(`  ✗ Graph has ${result.errors.length} error(s)`);
  }
  lines.push("");

  if (result.errors.length > 0) {
    lines.push("  ERRORS:");
    for (const e of result.errors) {
      lines.push(`    ✗ [${e.code}] ${e.message}`);
      lines.push(`      at ${e.location}`);
    }
    lines.push("");
  }

  if (result.warnings.length > 0) {
    lines.push("  WARNINGS:");
    for (const w of result.warnings) {
      lines.push(`    ⚠ [${w.code}] ${w.message}`);
      if (w.suggestion) lines.push(`      → ${w.suggestion}`);
    }
    lines.push("");
  }

  lines.push("  STATS:");
  lines.push(`    Models checked:       ${result.stats.modelsChecked}`);
  lines.push(`    Routes checked:       ${result.stats.routesChecked}`);
  lines.push(`    Constraints verified: ${result.stats.constraintsVerified}`);
  lines.push(`    Effects tracked:      ${result.stats.effectsTracked}`);
  lines.push(`    Proofs present:       ${result.stats.proofsPresent}`);
  lines.push(`    Proofs missing:       ${result.stats.proofsMissing}`);

  return lines.join("\n");
}
