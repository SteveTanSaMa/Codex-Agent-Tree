export type ErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "BUDGET_EXHAUSTED"
  | "OWNER_ACTIVE"
  | "STALE_OWNER"
  | "STALE_BINDING"
  | "STALE_REVISION"
  | "STATE_BLOCKED";
export class AgentTreeError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "AgentTreeError";
  }
}
export function requireCondition(
  condition: unknown,
  code: ErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new AgentTreeError(code, message);
}
export function text(value: unknown, name: string, max = 12000): string {
  requireCondition(
    typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= max &&
      value.isWellFormed() &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value),
    "INVALID_INPUT",
    `Invalid ${name}`,
  );
  return value;
}
export function integer(value: number, name: string, min = 0): number {
  requireCondition(
    Number.isSafeInteger(value) && value >= min,
    "INVALID_INPUT",
    `Invalid ${name}`,
  );
  return value;
}
