import test from "node:test";
import assert from "node:assert/strict";
import { queueNameFor } from "../worker/queue-name.js";

test("Render cannot share a queue with a local container or another service", () => {
  const render = queueNameFor("falai", { RENDER_SERVICE_ID: "srv-production" });
  assert.notEqual(render, queueNameFor("falai", {}));
  assert.notEqual(render, queueNameFor("falai", { RENDER_SERVICE_ID: "srv-other" }));
  assert.notEqual(render, "tvc-v2-falai");
});
test("new revisions of the same Render service keep the same queue", () => {
  assert.equal(queueNameFor("falai", { RENDER_SERVICE_ID: "srv-production", RENDER_GIT_COMMIT: "old" }),
    queueNameFor("falai", { RENDER_SERVICE_ID: "srv-production", RENDER_GIT_COMMIT: "new" }));
});
