// ============================================================
// KLAR-IR Graph Builder
// Fluent API for constructing semantic graphs.
// This is what an AI agent calls to build a program.
// ============================================================

import {
  KlarGraph, ModelDef, RouteDef, MiddlewareDef, Scope, Node, Edge,
  Field, KlarType, Constraint, Effect, Proof, Provenance,
  GraphConfig, JournalEntry, ScopeInterface,
  nextId, resetIds, T, ConstraintOp, EffectKind
} from "./types.js";

function now(): string {
  return new Date().toISOString();
}

function prov(instruction: string): Provenance {
  return { createdBy: "klar_builder", instruction, timestamp: now() };
}

// --- Field Builder ---
export class FieldBuilder {
  private _name: string;
  private _type: KlarType;
  private _constraints: Constraint[] = [];
  private _default?: any;

  constructor(name: string, type: KlarType) {
    this._name = name;
    this._type = type;
  }

  constraint(op: ConstraintOp, value: any, message: string): this {
    this._constraints.push({
      id: nextId("c"),
      op,
      field: this._name,
      value,
      message,
      enforcement: "boundary",
    });
    return this;
  }

  minLength(n: number, msg?: string): this {
    this._constraints.push({
      id: nextId("c"),
      op: "length_between",
      field: this._name,
      min: n,
      message: msg ?? `${this._name} must be at least ${n} characters`,
      enforcement: "boundary",
    });
    return this;
  }

  maxLength(n: number, msg?: string): this {
    this._constraints.push({
      id: nextId("c"),
      op: "length_between",
      field: this._name,
      max: n,
      message: msg ?? `${this._name} must be at most ${n} characters`,
      enforcement: "boundary",
    });
    return this;
  }

  matches(pattern: string, msg?: string): this {
    this._constraints.push({
      id: nextId("c"),
      op: "matches",
      field: this._name,
      pattern,
      message: msg ?? `${this._name} must match pattern ${pattern}`,
      enforcement: "boundary",
    });
    return this;
  }

  notEmpty(msg?: string): this {
    return this.minLength(1, msg ?? `${this._name} must not be empty`);
  }

  default(val: any): this {
    this._default = val;
    return this;
  }

  build(): Field {
    return {
      name: this._name,
      type: this._type,
      constraints: this._constraints,
      defaultValue: this._default,
    };
  }
}

// --- Model Builder ---
export class ModelBuilder {
  private _id: string;
  private _name: string;
  private _fields: Field[] = [];
  private _constraints: Constraint[] = [];
  private _indexes: { fields: string[]; unique: boolean }[] = [];

  constructor(name: string) {
    this._id = nextId("model");
    this._name = name;
  }

  field(name: string, type: KlarType, configure?: (fb: FieldBuilder) => void): this {
    const fb = new FieldBuilder(name, type);
    if (configure) configure(fb);
    this._fields.push(fb.build());
    return this;
  }

  // Shorthand for common field patterns
  id(): this { return this.field("id", T.str); }
  createdAt(): this { return this.field("createdAt", T.timestamp); }
  updatedAt(): this { return this.field("updatedAt", T.timestamp); }
  timestamps(): this { return this.createdAt().updatedAt(); }

  index(fields: string[], unique = false): this {
    this._indexes.push({ fields, unique });
    return this;
  }

  uniqueIndex(...fields: string[]): this {
    return this.index(fields, true);
  }

  build(): ModelDef {
    return {
      id: this._id,
      name: this._name,
      fields: this._fields,
      constraints: this._constraints,
      indexes: this._indexes,
      provenance: prov(`Define model ${this._name}`),
    };
  }
}

// --- Route Builder ---
export class RouteBuilder {
  private _id: string;
  private _method: RouteDef["method"];
  private _path: string;
  private _handler: string = "";
  private _middleware: string[] = [];
  private _params: Field[] = [];
  private _query: Field[] = [];
  private _body: Field[] = [];
  private _headers: Field[] = [];
  private _output: KlarType = T.void;
  private _effects: Effect[] = [];
  private _constraints: Constraint[] = [];
  private _proofs: Proof[] = [];
  private _handlerLogic: HandlerStep[] = [];
  private _description: string = "";

  constructor(method: RouteDef["method"], path: string) {
    this._id = nextId("route");
    this._method = method;
    this._path = path;
  }

  describe(d: string): this { this._description = d; return this; }

  param(name: string, type: KlarType, configure?: (fb: FieldBuilder) => void): this {
    const fb = new FieldBuilder(name, type);
    if (configure) configure(fb);
    this._params.push(fb.build());
    return this;
  }

  query(name: string, type: KlarType, configure?: (fb: FieldBuilder) => void): this {
    const fb = new FieldBuilder(name, type);
    if (configure) configure(fb);
    this._query.push(fb.build());
    return this;
  }

  body(name: string, type: KlarType, configure?: (fb: FieldBuilder) => void): this {
    const fb = new FieldBuilder(name, type);
    if (configure) configure(fb);
    this._body.push(fb.build());
    return this;
  }

  header(name: string, type: KlarType): this {
    this._headers.push({ name, type, constraints: [] });
    return this;
  }

  returns(type: KlarType): this { this._output = type; return this; }

  uses(...middlewareIds: string[]): this {
    this._middleware.push(...middlewareIds);
    return this;
  }

  effect(kind: EffectKind, detail?: string): this {
    this._effects.push({ kind, detail });
    return this;
  }

  // Handler logic DSL
  step(action: string, detail: Record<string, any> = {}): this {
    this._handlerLogic.push({ action, detail, id: nextId("step") });
    return this;
  }

  dbQuery(operation: string, model: string, where?: Record<string, any>): this {
    this.effect("DB", `${operation} on ${model}`);
    return this.step("db_query", { operation, model, where });
  }

  dbInsert(model: string, data: string = "body"): this {
    this.effect("DB", `insert into ${model}`);
    return this.step("db_insert", { model, data });
  }

  dbUpdate(model: string, where: Record<string, any>, data: string = "body"): this {
    this.effect("DB", `update ${model}`);
    return this.step("db_update", { model, where, data });
  }

  dbDelete(model: string, where: Record<string, any>): this {
    this.effect("DB", `delete from ${model}`);
    return this.step("db_delete", { model, where });
  }

  hashField(field: string): this {
    return this.step("hash", { field, algorithm: "bcrypt" });
  }

  compareHash(input: string, stored: string): this {
    return this.step("compare_hash", { input, stored });
  }

  signToken(payload: Record<string, string>, expiresIn: string = "24h"): this {
    return this.step("sign_token", { payload, expiresIn });
  }

  respond(status: number, bodyExpr: string = "result"): this {
    return this.step("respond", { status, body: bodyExpr });
  }

  respondError(status: number, message: string): this {
    return this.step("respond_error", { status, message });
  }

  validate(field: string, check: string): this {
    return this.step("validate", { field, check });
  }

  branch(condition: string, then: HandlerStep[], otherwise?: HandlerStep[]): this {
    return this.step("branch", { condition, then, else: otherwise });
  }

  proof(property: string, kind: Proof["kind"], detail: string): this {
    this._proofs.push({ property, kind, detail });
    return this;
  }

  build(): RouteDef & { _handlerLogic: HandlerStep[] } {
    return {
      id: this._id,
      method: this._method,
      path: this._path,
      handler: this._id + "_handler",
      middleware: this._middleware,
      input: {
        params: this._params.length ? this._params : undefined,
        query: this._query.length ? this._query : undefined,
        body: this._body.length ? this._body : undefined,
        headers: this._headers.length ? this._headers : undefined,
      },
      output: this._output,
      effects: this._effects,
      constraints: this._constraints,
      proofs: this._proofs,
      provenance: prov(this._description || `${this._method} ${this._path}`),
      _handlerLogic: this._handlerLogic,
    };
  }
}

export interface HandlerStep {
  id: string;
  action: string;
  detail: Record<string, any>;
}

// --- Middleware Builder ---
export class MiddlewareBuilder {
  private _id: string;
  private _name: string;
  private _appliesTo: string[] | "all" = "all";
  private _order: number;
  private _config: Record<string, any> = {};
  private _effects: Effect[] = [];
  private _type: string = "custom";

  constructor(name: string, order: number = 0) {
    this._id = nextId("mw");
    this._name = name;
    this._order = order;
  }

  get id(): string { return this._id; }

  appliesTo(...routeIds: string[]): this {
    this._appliesTo = routeIds;
    return this;
  }

  config(key: string, value: any): this {
    this._config[key] = value;
    return this;
  }

  effect(kind: EffectKind, detail?: string): this {
    this._effects.push({ kind, detail });
    return this;
  }

  type(t: string): this { this._type = t; return this; }

  // Presets
  static rateLimit(windowMs: number, max: number, order: number = 10): MiddlewareBuilder {
    return new MiddlewareBuilder("rateLimit", order)
      .type("rate_limit")
      .config("windowMs", windowMs)
      .config("maxRequests", max)
      .effect("State", "request counter");
  }

  static cors(origins: string[], methods: string[] = ["GET", "POST", "PUT", "DELETE"], order: number = 0): MiddlewareBuilder {
    return new MiddlewareBuilder("cors", order)
      .type("cors")
      .config("origins", origins)
      .config("methods", methods);
  }

  static auth(secret: string = "process.env.JWT_SECRET", order: number = 20): MiddlewareBuilder {
    return new MiddlewareBuilder("auth", order)
      .type("jwt_auth")
      .config("secret", secret)
      .config("headerName", "Authorization")
      .config("scheme", "Bearer")
      .effect("IO", "reads auth header");
  }

  static logger(order: number = 1): MiddlewareBuilder {
    return new MiddlewareBuilder("logger", order)
      .type("logger")
      .effect("Log", "request logging")
      .effect("Time", "request timing");
  }

  build(): MiddlewareDef & { _type: string } {
    return {
      id: this._id,
      name: this._name,
      scope: this._id + "_scope",
      appliesTo: this._appliesTo,
      order: this._order,
      config: this._config,
      effects: this._effects,
      provenance: prov(`Middleware: ${this._name}`),
      _type: this._type,
    };
  }
}

// --- Graph Builder (top-level) ---
export class GraphBuilder {
  private _name: string;
  private _config: GraphConfig;
  private _models: ModelDef[] = [];
  private _routes: (RouteDef & { _handlerLogic: HandlerStep[] })[] = [];
  private _middleware: (MiddlewareDef & { _type: string })[] = [];
  private _journal: JournalEntry[] = [];

  constructor(name: string) {
    resetIds();
    this._name = name;
    this._config = { port: 3000, host: "0.0.0.0" };
  }

  config(cfg: Partial<GraphConfig>): this {
    this._config = { ...this._config, ...cfg };
    return this;
  }

  model(name: string, configure: (mb: ModelBuilder) => void): this {
    const mb = new ModelBuilder(name);
    configure(mb);
    const model = mb.build();
    this._models.push(model);
    this._journal.push({
      id: nextId("j"),
      timestamp: now(),
      op: { kind: "AddModel", model },
      reason: `Define model ${name}`,
    });
    return this;
  }

  route(method: RouteDef["method"], path: string, configure: (rb: RouteBuilder) => void): this {
    const rb = new RouteBuilder(method, path);
    configure(rb);
    const route = rb.build();
    this._routes.push(route);
    this._journal.push({
      id: nextId("j"),
      timestamp: now(),
      op: { kind: "AddRoute", route },
      reason: `Add route ${method} ${path}`,
    });
    return this;
  }

  middleware(configure: (typeof MiddlewareBuilder) & (new (name: string, order?: number) => MiddlewareBuilder)): this;
  middleware(builder: MiddlewareBuilder): this;
  middleware(arg: any): this {
    const builder = arg instanceof MiddlewareBuilder ? arg : arg;
    const mw = builder.build();
    this._middleware.push(mw);
    this._journal.push({
      id: nextId("j"),
      timestamp: now(),
      op: { kind: "AddMiddleware", middleware: mw },
      reason: `Add middleware ${mw.name}`,
    });
    return this;
  }

  // Apply a semantic diff operation
  propagateField(modelName: string, fieldName: string, type: KlarType, configure?: (fb: FieldBuilder) => void): this {
    const fb = new FieldBuilder(fieldName, type);
    if (configure) configure(fb);
    const field = fb.build();

    const model = this._models.find(m => m.name === modelName);
    if (model) {
      model.fields.push(field);
    }

    this._journal.push({
      id: nextId("j"),
      timestamp: now(),
      op: { kind: "PropagateField", model: modelName, field },
      reason: `Add field ${fieldName} to ${modelName} and propagate`,
    });

    return this;
  }

  build(): KlarGraph & {
    _routes: (RouteDef & { _handlerLogic: HandlerStep[] })[];
    _middleware: (MiddlewareDef & { _type: string })[];
  } {
    const models = new Map<string, ModelDef>();
    for (const m of this._models) models.set(m.name, m);

    return {
      id: nextId("graph"),
      name: this._name,
      version: "0.1.0",
      nodes: new Map(),
      edges: [],
      scopes: new Map(),
      models,
      routes: this._routes,
      middleware: this._middleware,
      config: this._config,
      journal: this._journal,
      _routes: this._routes,
      _middleware: this._middleware,
    };
  }
}

// --- Convenience entry point ---
export function klar(name: string): GraphBuilder {
  return new GraphBuilder(name);
}
