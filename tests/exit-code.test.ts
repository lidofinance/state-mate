import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkFailureExitCode } from "../src/state-mate";

describe("check failure exit code", () => {
  it("does not wrap large error counts into a successful process status", () => {
    assert.equal(checkFailureExitCode(0), 0);
    assert.equal(checkFailureExitCode(1), 1);
    assert.equal(checkFailureExitCode(141), 1);
    assert.equal(checkFailureExitCode(256), 1);
  });
});
