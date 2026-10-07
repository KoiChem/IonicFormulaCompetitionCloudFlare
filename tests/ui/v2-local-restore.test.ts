import { describe, expect, it } from "vitest";
import { isRestorableV2Local } from "../../src/features/play/v2-local";

const valid = { manifestId: "manifest", evaluatorVersion: "v1", gradingMode: "deferred", questions: [{ id: "q1" }], writerEpoch: 1, ackSeq: 0, operations: [], ordinal: 0, drafts: {}, finished: false };

describe("saved competition restoration", () => {
  it("accepts a matching record with a pending operation", () => {
    expect(isRestorableV2Local({ ...valid, operations: [{ seq: 1, operationId: "operation" }], inflight: { requestId: "request", operations: [{ seq: 1, operationId: "operation" }] } }, "manifest", "v1", ["q1"])).toBe(true);
  });
  it("rejects an unrelated manifest, a missing question, or broken sequence", () => {
    expect(isRestorableV2Local(valid, "other", "v1", ["q1"])).toBe(false);
    expect(isRestorableV2Local(valid, "manifest", "v1", ["q2"])).toBe(false);
    expect(isRestorableV2Local({ ...valid, operations: [{ seq: 2, operationId: "operation" }] }, "manifest", "v1", ["q1"])).toBe(false);
  });
});
