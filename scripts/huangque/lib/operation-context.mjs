import { AsyncLocalStorage } from "node:async_hooks";

const operationContext = new AsyncLocalStorage();

export function createOperationState(signal) {
  return { signal, runIds: new Set() };
}

export function runWithOperationSignal(signal, callback, state = createOperationState(signal)) {
  return operationContext.run(state, callback);
}

export function runWithoutOperationContext(callback) {
  return operationContext.run(null, callback);
}

export function registerOperationRun(runId) {
  const state = operationContext.getStore();
  if (state?.runIds && runId) state.runIds.add(runId);
}

export function currentOperationSignal() {
  return operationContext.getStore()?.signal || null;
}

export function throwIfOperationAborted() {
  const signal = currentOperationSignal();
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw Object.assign(new Error("操作已取消"), { code: "TOOL_DEADLINE_EXCEEDED" });
}
