import {normalizePayment, normalizeUnits, type JsonObject} from './tm.js';

function requireObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonObject;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  return requireArray(value, label).map((item, index) => requireString(item, `${label}[${index}]`));
}

/**
 * Validates and normalizes one of the official InputResponse shapes.
 * The official server uses exact-key matching for many responses, so only the
 * fields belonging to the selected type are kept.
 */
export function normalizeInputResponse(raw: unknown, depth = 0): JsonObject {
  if (depth > 12) {
    throw new Error('Input response nesting is too deep.');
  }
  const response = requireObject(raw, 'Input response');
  const type = requireString(response.type, 'Input response type');

  switch (type) {
  case 'option':
    return {type};
  case 'or':
    return {
      type,
      index: requireInteger(response.index, 'index'),
      response: normalizeInputResponse(response.response, depth + 1),
    };
  case 'and':
  case 'initialCards':
    return {
      type,
      responses: requireArray(response.responses, 'responses')
        .map((item) => normalizeInputResponse(item, depth + 1)),
    };
  case 'card':
    return {type, cards: stringArray(response.cards, 'cards')};
  case 'projectCard':
    return {
      type,
      card: requireString(response.card, 'card'),
      payment: normalizePayment(response.payment),
    };
  case 'space':
    return {type, spaceId: requireString(response.spaceId, 'spaceId')};
  case 'player':
    return {type, player: requireString(response.player, 'player')};
  case 'party':
    return {type, partyName: requireString(response.partyName, 'partyName')};
  case 'delegate':
    return {type, player: requireString(response.player, 'player')};
  case 'amount':
    return {type, amount: requireInteger(response.amount, 'amount')};
  case 'colony':
    return {type, colonyName: requireString(response.colonyName, 'colonyName')};
  case 'payment':
    return {type, payment: normalizePayment(response.payment)};
  case 'productionToLose':
    return {type, units: normalizeUnits(response.units)};
  case 'aresGlobalParameters':
    return {type, response: requireObject(response.response, 'response')};
  case 'globalEvent':
    return {type, globalEventName: requireString(response.globalEventName, 'globalEventName')};
  case 'policy':
    return {type, policyId: requireString(response.policyId, 'policyId')};
  case 'resource':
    return {type, resource: requireString(response.resource, 'resource')};
  case 'resources':
    return {type, units: normalizeUnits(response.units)};
  case 'claimedUndergroundToken':
    return {
      type,
      selected: requireArray(response.selected, 'selected')
        .map((item, index) => requireInteger(item, `selected[${index}]`)),
    };
  case 'deltaProject':
    return {type, amount: requireInteger(response.amount, 'amount')};
  default:
    throw new Error(
      `Unknown modeled input type "${type}". Use submit_raw_entity to pass a new upstream response type.`,
    );
  }
}

/** Escape hatch validation: only require an object with a type. */
export function validateRawEntity(raw: unknown): JsonObject {
  const entity = requireObject(raw, 'entity');
  requireString(entity.type, 'entity.type');
  return entity;
}
