// ─── JSON Schema reutilizables para validación de rutas Fastify ───────────────
//
// Uso en rutas:
//   const { bodySchema } = require("../../lib/v2/validators");
//   fastify.post("/route", { schema: { body: bodySchema.login } }, handler)

const email = {
  type: "string",
  format: "email",
  minLength: 3,
  maxLength: 255,
};

const password = {
  type: "string",
  minLength: 8,
  maxLength: 128,
};

const passwordPlatform = {
  type: "string",
  minLength: 6,
  maxLength: 128,
};

const uuid = {
  type: "string",
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
};

const username = {
  type: "string",
  minLength: 2,
  maxLength: 64,
  pattern: "^[a-zA-Z0-9_.-]+$",
};

// ─── Body schemas ─────────────────────────────────────────────────────────────

const body = {
  // Project auth
  register: {
    type: "object",
    required: ["email", "password"],
    additionalProperties: true,
    properties: {
      email,
      password,
      username: { type: "string", maxLength: 64 },
      name:     { type: "string", maxLength: 128 },
      login_url: { type: "string", maxLength: 2048 },
    },
  },

  login: {
    type: "object",
    required: ["email", "password"],
    additionalProperties: false,
    properties: { email, password },
  },

  refresh: {
    type: "object",
    required: ["refresh_token"],
    additionalProperties: false,
    properties: {
      refresh_token: { type: "string", minLength: 10 },
    },
  },

  logout: {
    type: "object",
    additionalProperties: false,
    properties: {
      refresh_token: { type: "string" },
    },
  },

  patchMe: {
    type: "object",
    additionalProperties: false,
    properties: {
      name:     { type: "string", maxLength: 128 },
      username: { type: "string", maxLength: 64 },
    },
  },

  requestReset: {
    type: "object",
    required: ["email"],
    additionalProperties: false,
    properties: {
      email,
      reset_url_base: { type: "string", maxLength: 2048 },
    },
  },

  resetPassword: {
    type: "object",
    required: ["token", "password"],
    additionalProperties: false,
    properties: {
      token:    { type: "string", minLength: 10 },
      password,
    },
  },

  verifyEmail: {
    type: "object",
    additionalProperties: false,
    properties: {
      email: { type: "string" },
      userId: { type: "string" },
      login_url: { type: "string" },
    },
  },

  oauthExchange: {
    type: "object",
    required: ["code"],
    additionalProperties: false,
    properties: {
      code: { type: "string", minLength: 10 },
    },
  },

  // Platform auth
  platformRegister: {
    type: "object",
    required: ["username", "name", "email", "password"],
    additionalProperties: true,
    properties: {
      username,
      name:     { type: "string", minLength: 1, maxLength: 128 },
      email,
      password: passwordPlatform,
    },
  },

  platformLogin: {
    type: "object",
    required: ["email", "password"],
    additionalProperties: false,
    properties: { email, password: passwordPlatform },
  },

  // Data
  createRecord: {
    type: "object",
    required: ["collection", "data"],
    additionalProperties: true,
    properties: {
      collection:  { type: "string", minLength: 1, maxLength: 64 },
      data:        { type: "object" },
      expires_at:  { type: "string" },
    },
  },

  updateRecord: {
    type: "object",
    required: ["data"],
    additionalProperties: true,
    properties: {
      data:       { type: "object" },
      merge:      { type: "boolean" },
      expires_at: {},
    },
  },

  upsert: {
    type: "object",
    required: ["collection", "data", "match"],
    additionalProperties: false,
    properties: {
      collection: { type: "string", minLength: 1, maxLength: 64 },
      data:       { type: "object" },
      match:      { type: "array", items: { type: "string" }, minItems: 1 },
      expires_at: { type: "string" },
    },
  },

  bulk: {
    type: "object",
    required: ["operations"],
    additionalProperties: false,
    properties: {
      operations: {
        type: "array",
        maxItems: 100,
        items: {
          type: "object",
          required: ["op"],
          properties: {
            op:         { type: "string", enum: ["insert", "update", "delete"] },
            collection: { type: "string" },
            id:         { type: "string" },
            data:       { type: "object" },
            merge:      { type: "boolean" },
          },
        },
      },
    },
  },

  createCollection: {
    type: "object",
    required: ["name"],
    additionalProperties: false,
    properties: {
      name:        { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-zA-Z_][a-zA-Z0-9_]*$" },
      soft_delete: { type: "boolean" },
    },
  },

  createField: {
    type: "object",
    required: ["name"],
    additionalProperties: false,
    properties: {
      name:        { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-zA-Z_][a-zA-Z0-9_]*$" },
      type:        { type: "string", enum: ["text", "number", "boolean", "date", "json", "relation"] },
      required:    { type: "boolean" },
      options:     { type: "object" },
      constraints: {
        type: "object",
        additionalProperties: false,
        properties: {
          min:        { type: "number" },
          max:        { type: "number" },
          minLength:  { type: "integer" },
          maxLength:  { type: "integer" },
          pattern:    { type: "string" },
          unique:     { type: "boolean" },
          enum:       { type: "array" },
        },
      },
    },
  },

  permissions: {
    type: "object",
    required: ["permissions"],
    additionalProperties: false,
    properties: {
      permissions: { type: "object" },
    },
  },

  apiKey: {
    type: "object",
    additionalProperties: false,
    properties: {
      scopes: { oneOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] },
      type:   { type: "string" },
    },
  },

  aggregate: {
    type: "object",
    required: ["collection"],
    additionalProperties: false,
    properties: {
      collection: { type: "string", minLength: 1, maxLength: 64 },
      group_by:   { type: "string" },
      count:      { type: "boolean" },
      sum:        { type: "string" },
      avg:        { type: "string" },
      min:        { type: "string" },
      max:        { type: "string" },
      filter:     { type: "object" },
    },
  },

  exportJob: {
    type: "object",
    required: ["collection"],
    additionalProperties: false,
    properties: {
      collection: { type: "string", minLength: 1, maxLength: 64 },
      format:     { type: "string", enum: ["json", "csv"] },
      filter:     { type: "object" },
    },
  },
};

// ─── Querystring schemas ──────────────────────────────────────────────────────

const querystring = {
  listRecords: {
    type: "object",
    additionalProperties: true,
    properties: {
      collection:      { type: "string" },
      limit:           { type: "string" },
      after:           { type: "string" },
      before:          { type: "string" },
      order:           { type: "string", enum: ["asc", "desc"] },
      sort:            { type: "string" },
      select:          { type: "string" },
      search:          { type: "string" },
      search_fields:   { type: "string" },
      or:              { type: "string" },
      include_deleted: { type: "string" },
      include_expired: { type: "string" },
    },
  },

  count: {
    type: "object",
    required: ["collection"],
    additionalProperties: true,
    properties: {
      collection: { type: "string" },
    },
  },
};

module.exports = { body, querystring, email, password, uuid };
