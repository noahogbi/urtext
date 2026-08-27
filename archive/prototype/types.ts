// ============================================================
// KLAR-IR Core Types
// The semantic graph that AI reasons in natively.
// ============================================================

// --- Node ID system ---
let _nextId = 1;
export function nextId(prefix: string = "n"): string {
  return `${prefix}_${String(_nextId++).padStart(4, "0")}`;
}
export function resetIds() { _nextId = 1; }

// --- Base types ---
export type KlarType =
  | { kind: "primitive"; name: "str" | "int" | "float" | "bool" | "void" | "timestamp" }
  | { kind: "option"; inner: KlarType }
  | { kind: "result"; ok: KlarType; err: KlarType }
  | { kind: "array"; element: KlarType }
  | { kind: "map"; key: KlarType; value: KlarType }
  | { kind: "ref"; structName: string }
  | { kind: "union"; name: string; variants: UnionVariant[] }
  | { kind: "refined"; base: KlarType; constraint: Constraint };

export interface UnionVariant {
  tag: string;
  fields: Field[];
}

export interface Field {
  name: string;
  type: KlarType;
  constraints: Constraint[];
  defaultValue?: any;
}

// --- Constraints ---
export type ConstraintOp = "==" | "!=" | ">" | "<" | ">=" | "<=" | "matches" | "in" | "not_in" | "length_between" | "custom";

export interface Constraint {
  id: string;
  op: ConstraintOp;
  field?: string;       // which field this constrains (or "self")
  value?: any;          // comparison value
  pattern?: string;     // for regex matches
  min?: number;         // for range/length constraints
  max?: number;
  message: string;      // human-readable explanation
  enforcement: "caller" | "boundary" | "runtime";
}

// --- Effects ---
export type EffectKind = "IO" | "State" | "Random" | "Time" | "DB" | "HTTP" | "Log" | "Panic";

export interface Effect {
  kind: EffectKind;
  detail?: string;      // e.g., "reads from users table"
}

// --- Proofs ---
export type ProofKind = "by_constraint" | "by_invariant" | "by_construction" | "by_test" | "by_solver" | "by_human";

export interface Proof {
  property: string;
  kind: ProofKind;
  detail: string;
  references?: string[];  // node IDs that support this proof
}

// --- Provenance ---
export interface Provenance {
  createdBy: string;
  instruction: string;
  timestamp: string;
}

// --- Nodes ---
export type NodeKind =
  | "Value"
  | "Binding"
  | "Transform"
  | "Construct"
  | "Destruct"
  | "Constraint"
  | "Effect"
  | "Scope"
  | "Projection"
  | "Route"
  | "Middleware"
  | "Model"
  | "Migration";

export interface Node {
  id: string;
  kind: NodeKind;
  label: string;
  type: KlarType;
  inputs: string[];       // IDs of nodes this depends on
  effects: Effect[];
  constraints: Constraint[];
  proofs: Proof[];
  provenance: Provenance;
  meta: Record<string, any>;  // extensible metadata
}

// --- Edges ---
export type EdgeKind = "data" | "constraint" | "effect_dep" | "scope_member" | "proof" | "projection";

export interface Edge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
}

// --- Scopes (functions, modules, routes) ---
export interface ScopeInterface {
  inputs: Field[];
  output: KlarType;
  effects: Effect[];
}

export interface Scope extends Node {
  kind: "Scope";
  interface: ScopeInterface;
  children: string[];     // IDs of nodes in this scope
  returnNode?: string;    // ID of the return value node
}

// --- The Graph itself ---
export interface KlarGraph {
  id: string;
  name: string;
  version: string;
  nodes: Map<string, Node>;
  edges: Edge[];
  scopes: Map<string, Scope>;
  models: Map<string, ModelDef>;
  routes: RouteDef[];
  middleware: MiddlewareDef[];
  config: GraphConfig;
  journal: JournalEntry[];
}

// --- High-level constructs (sugar over the graph) ---

export interface ModelDef {
  id: string;
  name: string;
  fields: Field[];
  constraints: Constraint[];
  indexes?: { fields: string[]; unique: boolean }[];
  provenance: Provenance;
}

export interface RouteDef {
  id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  handler: string;        // scope ID
  middleware: string[];    // middleware IDs
  input: {
    params?: Field[];
    query?: Field[];
    body?: Field[];
    headers?: Field[];
  };
  output: KlarType;
  effects: Effect[];
  constraints: Constraint[];
  proofs: Proof[];
  provenance: Provenance;
}

export interface MiddlewareDef {
  id: string;
  name: string;
  scope: string;         // scope ID for the middleware logic
  appliesTo: string[] | "all";  // route IDs or "all"
  order: number;
  config: Record<string, any>;
  effects: Effect[];
  provenance: Provenance;
}

export interface GraphConfig {
  port: number;
  host: string;
  database?: {
    type: "postgres" | "sqlite" | "mysql";
    url: string;
  };
  cors?: {
    origins: string[];
    methods: string[];
  };
  rateLimit?: {
    windowMs: number;
    maxRequests: number;
  };
}

// --- Diff Journal ---
export type JournalOp =
  | { kind: "AddNode"; node: Node }
  | { kind: "RemoveNode"; nodeId: string }
  | { kind: "AddEdge"; edge: Edge }
  | { kind: "RemoveEdge"; edgeId: string }
  | { kind: "AddConstraint"; nodeId: string; constraint: Constraint }
  | { kind: "PropagateField"; model: string; field: Field }
  | { kind: "AddRoute"; route: RouteDef }
  | { kind: "AddMiddleware"; middleware: MiddlewareDef }
  | { kind: "AddModel"; model: ModelDef };

export interface JournalEntry {
  id: string;
  timestamp: string;
  op: JournalOp;
  reason: string;
}

// --- Helpers ---
export const T = {
  str:       { kind: "primitive" as const, name: "str" as const },
  int:       { kind: "primitive" as const, name: "int" as const },
  float:     { kind: "primitive" as const, name: "float" as const },
  bool:      { kind: "primitive" as const, name: "bool" as const },
  void:      { kind: "primitive" as const, name: "void" as const },
  timestamp: { kind: "primitive" as const, name: "timestamp" as const },
  option:  (inner: KlarType): KlarType => ({ kind: "option", inner }),
  result:  (ok: KlarType, err: KlarType): KlarType => ({ kind: "result", ok, err }),
  array:   (el: KlarType): KlarType => ({ kind: "array", element: el }),
  map:     (k: KlarType, v: KlarType): KlarType => ({ kind: "map", key: k, value: v }),
  ref:     (name: string): KlarType => ({ kind: "ref", structName: name }),
  refined: (base: KlarType, constraint: Constraint): KlarType => ({ kind: "refined", base, constraint }),
};
