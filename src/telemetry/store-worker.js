import { parentPort, workerData } from "node:worker_threads";

import { createTelemetryStore } from "./store.js";

const store = createTelemetryStore({
  ...workerData,
  stderr: process.stderr,
});
const testWriteDelayMs = Number.isSafeInteger(workerData.testWriteDelayMs)
  ? Math.max(0, Math.min(workerData.testWriteDelayMs, 5_000))
  : 0;
const delaySignal = new Int32Array(new SharedArrayBuffer(4));

parentPort.postMessage({ type: "ready", status: store.getStatus() });

let commandChain = Promise.resolve();
parentPort.on("message", (message) => {
  commandChain = commandChain.then(() => handleCommand(message));
});

async function handleCommand(message) {
  const id = message?.id;
  try {
    const payload = message?.payload ?? {};
    let result = null;
    if (message.command === "write_batch") {
      if (testWriteDelayMs > 0) Atomics.wait(delaySignal, 0, 0, testWriteDelayMs);
      let accepted = 0;
      for (const event of payload.events ?? []) accepted += store.record(event) ? 1 : 0;
      if (store.queue) await store.queue.flush({ timeoutMs: 30_000 });
      result = { accepted };
    } else if (message.command === "dashboard") {
      result = store.getDashboard(payload.query ?? {});
    } else if (message.command === "events") {
      result = store.getEvents(payload.query ?? {});
    } else if (message.command === "scenarios") {
      result = store.getScenarios(payload.query ?? {});
    } else if (message.command === "maintenance") {
      result = await store.runMaintenance();
    } else if (message.command === "record_drop") {
      store.recordExternalDrop(payload.reason, payload.count);
      result = true;
    } else if (message.command === "close") {
      result = await store.close({ drain: payload.drain, timeoutMs: payload.timeoutMs });
    } else {
      throw new Error("Unknown telemetry worker command.");
    }
    parentPort.postMessage({
      id,
      ok: true,
      payload: { result, status: store.getStatus() },
    });
    if (message.command === "close") parentPort.close();
  } catch {
    parentPort.postMessage({ id, ok: false, status: store.getStatus() });
  }
}
