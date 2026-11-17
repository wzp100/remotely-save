import { strict as assert } from "node:assert";
import { compareVersions } from "../src/updateInfo";

describe("Plugin update version comparison", () => {
  it("orders versions numerically, not as text", () => {
    assert.equal(compareVersions("0.7.10", "0.7.9"), 1);
    assert.equal(compareVersions("0.7.7", "0.7.8"), -1);
    assert.equal(compareVersions("0.7.7", "0.7.7"), 0);
  });
  it("tolerates a v prefix and missing parts", () => {
    assert.equal(compareVersions("v0.8", "0.8.0"), 0);
    assert.equal(compareVersions("1", "0.9.9"), 1);
  });
});
