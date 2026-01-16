import { describe, expect, it } from "vitest";

import { isTypeOfTB, OzNonEnumerableAclOptionsTB, ProxyContractEntryTB } from "../typebox";

describe("OzNonEnumerableAclOptionsTB schema", () => {
  it("validates correct structure with exhaustive", () => {
    const valid = {
      exhaustive: true,
    };
    expect(isTypeOfTB(valid, OzNonEnumerableAclOptionsTB)).toBe(true);
  });

  it("validates correct structure with eventBatchSize", () => {
    const valid = {
      eventBatchSize: 5000,
    };
    expect(isTypeOfTB(valid, OzNonEnumerableAclOptionsTB)).toBe(true);
  });

  it("validates correct structure with both options", () => {
    const valid = {
      exhaustive: true,
      eventBatchSize: 3000,
    };
    expect(isTypeOfTB(valid, OzNonEnumerableAclOptionsTB)).toBe(true);
  });

  it("validates empty object (all fields optional)", () => {
    const valid = {};
    expect(isTypeOfTB(valid, OzNonEnumerableAclOptionsTB)).toBe(true);
  });

  it("rejects invalid properties", () => {
    const invalid = {
      exhaustive: true,
      unknownField: "value",
    };
    expect(isTypeOfTB(invalid, OzNonEnumerableAclOptionsTB)).toBe(false);
  });

  it("rejects wrong type for exhaustive", () => {
    const invalid = {
      exhaustive: "true", // should be boolean
    };
    expect(isTypeOfTB(invalid, OzNonEnumerableAclOptionsTB)).toBe(false);
  });

  it("rejects wrong type for eventBatchSize", () => {
    const invalid = {
      eventBatchSize: "5000", // should be number
    };
    expect(isTypeOfTB(invalid, OzNonEnumerableAclOptionsTB)).toBe(false);
  });
});

describe("ProxyContractEntryTB with ozNonEnumerableAclOptions", () => {
  const baseProxyContract = {
    address: "0x1234567890123456789012345678901234567890",
    name: "TestContract",
    proxyName: "OssifiableProxy",
    checks: {},
  };

  it("accepts contract entry with ozNonEnumerableAclOptions", () => {
    const validEntry = {
      ...baseProxyContract,
      ozNonEnumerableAcl: {
        "0x0000000000000000000000000000000000000000000000000000000000000000": [
          "0xabcdef1234567890abcdef1234567890abcdef12",
        ],
      },
      ozNonEnumerableAclOptions: {
        exhaustive: true,
        eventBatchSize: 3000,
      },
    };
    expect(isTypeOfTB(validEntry, ProxyContractEntryTB)).toBe(true);
  });

  it("accepts contract entry without ozNonEnumerableAclOptions (backward compatible)", () => {
    const validEntry = {
      ...baseProxyContract,
      ozNonEnumerableAcl: {
        "0x0000000000000000000000000000000000000000000000000000000000000000": [
          "0xabcdef1234567890abcdef1234567890abcdef12",
        ],
      },
    };
    expect(isTypeOfTB(validEntry, ProxyContractEntryTB)).toBe(true);
  });

  it("accepts contract entry with only exhaustive option", () => {
    const validEntry = {
      ...baseProxyContract,
      ozNonEnumerableAclOptions: {
        exhaustive: true,
      },
    };
    expect(isTypeOfTB(validEntry, ProxyContractEntryTB)).toBe(true);
  });

  it("rejects contract entry with invalid ozNonEnumerableAclOptions", () => {
    const invalidEntry = {
      ...baseProxyContract,
      ozNonEnumerableAclOptions: {
        exhaustive: "yes", // should be boolean
      },
    };
    expect(isTypeOfTB(invalidEntry, ProxyContractEntryTB)).toBe(false);
  });
});

describe("Backward compatibility", () => {
  it("existing config without options still validates", () => {
    const existingConfig = {
      address: "0x1234567890123456789012345678901234567890",
      name: "L1ERC20TokenBridge",
      proxyName: "OssifiableProxy",
      implementation: "0xabcdef1234567890abcdef1234567890abcdef12",
      proxyChecks: {
        proxy__getImplementation: "0xabcdef1234567890abcdef1234567890abcdef12",
      },
      checks: {
        isInitialized: true,
        isDepositsEnabled: true,
      },
      ozNonEnumerableAcl: {
        "0x0000000000000000000000000000000000000000000000000000000000000000": [
          "0x3e40d73eb977dc6a537af587d48316fee66e9c8c",
        ],
      },
    };
    expect(isTypeOfTB(existingConfig, ProxyContractEntryTB)).toBe(true);
  });
});
