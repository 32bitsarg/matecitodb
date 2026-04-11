// ─── Workflow Engine (N1) — State machine validator ─────────────────────────
//
// Valida transiciones de estado, evalúa guards, ejecuta on_enter functions.
// Se integra con update-record.js.

const db = require("../../db");
const { quoteIdent } = require("../matecito");

/**
 * Evalúa un guard expression contra un record.
 * Formato: "field.op:value" (mismo que RLS filters)
 */
function evalGuard(guard, recordData) {
  if (!guard) return true;
  const colonIdx = guard.indexOf(":");
  if (colonIdx <= 0) return true;

  const lhs = guard.slice(0, colonIdx).trim();
  const rhs = guard.slice(colonIdx + 1).trim();
  const dotIdx = lhs.lastIndexOf(".");
  const field = dotIdx > 0 ? lhs.slice(0, dotIdx) : lhs;
  const op = dotIdx > 0 ? lhs.slice(dotIdx + 1).toLowerCase() : "eq";

  const val = recordData?.[field];
  if (val === undefined) return false;

  switch (op) {
    case "eq":  return String(val) === rhs;
    case "neq": return String(val) !== rhs;
    case "gt":  return Number(val) > Number(rhs);
    case "gte": return Number(val) >= Number(rhs);
    case "lt":  return Number(val) < Number(rhs);
    case "lte": return Number(val) <= Number(rhs);
    case "in":  return rhs.split(",").map(s => s.trim()).includes(String(val));
    default:    return true;
  }
}

/**
 * Busca un workflow activo para una colección.
 */
async function findWorkflow(schemaName, collection) {
  const schema = quoteIdent(schemaName);
  const { rows } = await db.query(
    `SELECT * FROM ${schema}._workflows WHERE collection = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1`,
    [collection]
  );
  return rows[0] || null;
}

/**
 * Valida una transición de estado.
 * @returns {object} { allowed: boolean, error?, allowedTransitions? }
 */
function validateTransition(workflowDef, fromState, toState, userRoles, recordData) {
  const { transitions } = workflowDef;
  const allowed = [];

  for (const t of transitions) {
    const fromArr = Array.isArray(t.from) ? t.from : [t.from];
    if (!fromArr.includes(fromState)) {
      // Still collect allowed transitions from current state
      continue;
    }

    const isMatch = fromArr.includes(fromState) && t.to === toState;
    if (!isMatch && fromArr.includes(fromState)) {
      allowed.push({ to: t.to, label: t.label || t.to });
    }

    if (isMatch) {
      // Check guard
      if (t.guard && !evalGuard(t.guard, recordData)) {
        return { allowed: false, error: "Guard condition not met", code: "WF_002", allowedTransitions: allowed };
      }

      // Check roles (empty = anyone)
      if (t.roles && t.roles.length > 0) {
        const userRoleSet = new Set(userRoles || []);
        const requiredRoles = new Set(t.roles);
        const hasRole = [...requiredRoles].some(r => userRoleSet.has(r));
        if (!hasRole) {
          return { allowed: false, error: `Required roles: ${t.roles.join(", ")}`, code: "WF_003", allowedTransitions: allowed };
        }
      }

      return { allowed: true, transition: t };
    }
  }

  return { allowed: false, error: `Transition "${fromState}" → "${toState}" not defined`, code: "WF_001", allowedTransitions: allowed };
}

/**
 * Obtiene el estado actual + transiciones permitidas para un record.
 */
async function getWorkflowState(schemaName, workflow, recordId, record, userRoles) {
  const schema = quoteIdent(schemaName);
  const field = workflow.field;
  const currentState = record?.data?.[field] || workflow.definition.initial;

  const result = validateTransition(workflow.definition, currentState, "__dummy__", userRoles, record.data);
  const allowedTransitions = result.allowedTransitions || [];

  // Get history
  const { rows: history } = await db.query(
    `SELECT from_state, to_state, triggered_by, metadata, created_at
     FROM ${schema}._workflow_history
     WHERE workflow_id = $1 AND record_id = $2
     ORDER BY created_at DESC LIMIT 20`,
    [workflow.id, recordId]
  );

  return {
    current_state: currentState,
    allowed_transitions: allowedTransitions,
    history,
  };
}

/**
 * Ejecuta la función on_enter si está definida.
 */
async function executeOnEnter(schemaName, onEnter, record) {
  if (!onEnter) return;

  try {
    const { rows: fnRows } = await db.query(
      `SELECT id, name, code, timeout_ms FROM ${quoteIdent(schemaName)}._functions WHERE name = $1 LIMIT 1`,
      [onEnter]
    );

    if (!fnRows[0]) return;

    const { runFunction, createDbHelper } = require("./function-runner");
    const dbModule = require("./auth");

    const context = {
      args: { record, event: "state_entered", state: onEnter },
      user: null,
      db: createDbHelper(dbModule.db, quoteIdent, schemaName),
      fetch: globalThis.fetch?.bind(globalThis),
      env: {},
    };

    await runFunction({ code: fnRows[0].code, timeoutMs: fnRows[0].timeout_ms || 5000, context });
  } catch (err) {
    console.error(`[workflow] on_enter "${onEnter}" failed:`, err.message);
  }
}

module.exports = {
  evalGuard,
  findWorkflow,
  validateTransition,
  getWorkflowState,
  executeOnEnter,
};
