import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { Contract, JsonRpcProvider } from "ethers";

import { type AragonEvent, EMPTY_PARAM_HASH, managerSlot, paramsDigest, permissionSlot } from "../src/acl/aragon";
import { context, resetStats, stats } from "../src/context";
import { AragonAclSectionValidator } from "../src/section-validators/aragon-acl";
import { resetContractCounters } from "../src/section-validators/base";
import type { ContractEntry } from "../src/typebox";

const ACL = "0x9895f0f17cc1d1891b6f18ee0b483b6f221b37bb";
const LIDO = "0xae7ab96520de3a18e5e111b5eaab095312d7fe84";
const AGENT = "0x3e40d73eb977dc6a537af587d48316fee66e9c8c";
const VOTING = "0x2e59a20f205bb85a89c53f1936454680651e618e";
const SDVT = "0xae7b191a31f627b4eb1d4dac64eab9976995b433";
const STRANGER = "0x00000000000000000000000000000000deadbeef";
const ROLE = "0x33969636f1fbf3d7d062d4de4a08e7bd3c46606ec28b3a4398d2665be559b921";
const MSK = "0x75abc64490e17b40ea1e66691c3eb493647b24430b358bd87ec3e5127f1621ee";
const HASH_A = `0x${"a".repeat(64)}`;
const ZERO_WORD = `0x${"0".repeat(64)}`;
const word = (address: string) => `0x${"0".repeat(24)}${address.slice(2)}`;

function grant(entity: string, app: string, role: string, block = 1): AragonEvent {
  return { allowed: true, app, blockNumber: block, entity, kind: "permission", logIndex: 0, role };
}
function params(entity: string, app: string, role: string, hash: string, block = 1): AragonEvent {
  return { app, blockNumber: block, entity, kind: "params", logIndex: 0, paramsHash: hash, role };
}
function manager(app: string, role: string, who: string, block = 1): AragonEvent {
  return { app, blockNumber: block, kind: "manager", logIndex: 0, manager: who, role };
}

interface Stub {
  events: AragonEvent[];
  hasPermission?: Record<string, boolean>;
  managers?: Record<string, string>;
  paramsLength?: number;
  slots?: Record<string, string>;
}

class ExposedAragon extends AragonAclSectionValidator {
  constructor(
    chainId: string,
    private readonly stub: Stub,
  ) {
    const provider = {
      getStorage: async (_a: string, slot: string) => stub.slots?.[slot.toLowerCase()] ?? ZERO_WORD,
    } as unknown as JsonRpcProvider;
    super(provider, chainId);
  }

  protected override async _scan() {
    return { events: this.stub.events, fromBlock: 1, ok: true as const, source: "test", toBlock: 99 };
  }

  protected override _aclContract(): Contract {
    const { hasPermission = {}, managers = {}, paramsLength = 1 } = this.stub;
    return {
      getFunction: (name: string) => ({
        staticCall: (...args: string[]) => {
          if (name === "hasPermission") return Promise.resolve(hasPermission[args.join("|").toLowerCase()] ?? false);
          if (name === "getPermissionManager")
            return Promise.resolve(managers[args.join("|").toLowerCase()] ?? `0x${"0".repeat(40)}`);
          return Promise.resolve(paramsLength);
        },
      }),
    } as unknown as Contract;
  }
}

/** A healthy DAO: one unconditional grant, its manager, everything agreeing. */
function healthyStub(): Stub {
  return {
    events: [grant(AGENT, LIDO, ROLE), manager(LIDO, ROLE, AGENT)],
    hasPermission: { [`${AGENT}|${LIDO}|${ROLE}`]: true },
    managers: { [`${LIDO}|${ROLE}`]: AGENT },
    slots: {
      [permissionSlot(AGENT, LIDO, ROLE)]: EMPTY_PARAM_HASH,
      [managerSlot(LIDO, ROLE)]: word(AGENT),
    },
  };
}

function entry(aragonAcl: unknown): ContractEntry {
  return { address: ACL, aragonAcl, checks: {}, name: "ACL" } as unknown as ContractEntry;
}

const DECLARED = { [LIDO]: { [ROLE]: { granted: [AGENT], manager: AGENT } } };

describe("aragon ACL validator", () => {
  beforeEach(() => {
    resetStats();
    resetContractCounters();
    context.quiet = true;
  });

  it("passes a DAO whose events, views, and slots all agree with the config", async () => {
    await new ExposedAragon("1", healthyStub()).validateSection(entry(DECLARED), "acl");

    assert.equal(stats.errors, 0);
    assert.equal(stats.totalChecks, 2, "one manager check, one grant check");
  });

  it("records a skip, never a pass, on a chain with no log source", async () => {
    await new ExposedAragon("56", healthyStub()).validateSection(entry(DECLARED), "acl");

    assert.deepEqual(
      { checks: stats.totalChecks, errors: stats.errors, skipped: stats.skipped },
      { checks: 0, errors: 0, skipped: 1 },
    );
  });

  it("refuses to run when the confirmed grant does not read back from the aragonOS slot", async () => {
    const stub = healthyStub();
    stub.slots = { [managerSlot(LIDO, ROLE)]: word(AGENT) }; // permission slot now empty
    await new ExposedAragon("1", stub).validateSection(entry(DECLARED), "acl");

    assert.equal(stats.errors, 1);
    assert.match(stats.errorDetails[0].message, /does not store permissions where the ACL stores them/);
  });

  it("reports a live grant on an app nobody declared", async () => {
    const stub = healthyStub();
    stub.events.push(grant(STRANGER, SDVT, MSK, 5));
    stub.slots![permissionSlot(STRANGER, SDVT, MSK)] = EMPTY_PARAM_HASH;
    await new ExposedAragon("1", stub).validateSection(entry(DECLARED), "acl");

    assert.equal(stats.errors, 1);
    assert.match(stats.errorDetails[0].message, /undeclared unconditional permission/);
  });

  it("clears an undeclared event the storage does not corroborate", async () => {
    const stub = healthyStub();
    stub.events.push(grant(STRANGER, SDVT, MSK, 5)); // no slot backing it
    await new ExposedAragon("1", stub).validateSection(entry(DECLARED), "acl");

    assert.equal(stats.errors, 0);
  });

  it("fails a declared grantee the chain does not hold", async () => {
    const stub = healthyStub();
    const declared = { [LIDO]: { [ROLE]: { granted: [AGENT, VOTING], manager: AGENT } } };
    await new ExposedAragon("1", stub).validateSection(entry(declared), "acl");

    assert.ok(stats.errorDetails.some((d) => /expected an unconditional live grant/.test(d.message)));
  });

  it("fails a manager whose three answers do not all match the pin", async () => {
    const stub = healthyStub();
    stub.managers = { [`${LIDO}|${ROLE}`]: VOTING }; // view disagrees with events+slot+pin
    await new ExposedAragon("1", stub).validateSection(entry(DECLARED), "acl");

    assert.ok(stats.errorDetails.some((d) => /expected manager/.test(d.message)));
  });

  it("reports a live manager on a declared app for an undeclared role", async () => {
    const stub = healthyStub();
    stub.events.push(manager(LIDO, MSK, VOTING, 6));
    await new ExposedAragon("1", stub).validateSection(entry(DECLARED), "acl");

    assert.ok(stats.errorDetails.some((d) => /has manager .* but is not declared/.test(d.message)));
  });

  describe("parameterized grants", () => {
    const pinned = paramsDigest([{ entity: STRANGER, paramsHash: HASH_A }]);
    const withParams = (): Stub => {
      const stub = healthyStub();
      stub.events.push(
        grant(STRANGER, LIDO, MSK, 5),
        params(STRANGER, LIDO, MSK, HASH_A, 5),
        manager(LIDO, MSK, AGENT, 5),
      );
      stub.managers![`${LIDO}|${MSK}`] = AGENT;
      stub.slots![permissionSlot(STRANGER, LIDO, MSK)] = HASH_A;
      stub.slots![managerSlot(LIDO, MSK)] = word(AGENT);
      return stub;
    };
    const declared = {
      [LIDO]: {
        [ROLE]: { granted: [AGENT], manager: AGENT },
        [MSK]: { manager: AGENT, paramsDigest: pinned },
      },
    };

    it("passes when the pinned digest matches events and slots, without asking hasPermission", async () => {
      const stub = withParams();
      // the view answers FALSE for conditional grants, as measured on mainnet; must not matter
      await new ExposedAragon("1", stub).validateSection(entry(declared), "acl");

      assert.equal(stats.errors, 0);
    });

    it("fails when the slot hash drifts from the events", async () => {
      const stub = withParams();
      stub.slots![permissionSlot(STRANGER, LIDO, MSK)] = `0x${"b".repeat(64)}`;
      await new ExposedAragon("1", stub).validateSection(entry(declared), "acl");

      assert.ok(stats.errorDetails.some((d) => /events fold to|slots to/.test(d.message)));
    });

    it("fails parameterized grants that exist with no digest pinned", async () => {
      const stub = withParams();
      const bare = { [LIDO]: { [ROLE]: { granted: [AGENT], manager: AGENT }, [MSK]: { manager: AGENT } } };
      await new ExposedAragon("1", stub).validateSection(entry(bare), "acl");

      assert.ok(stats.errorDetails.some((d) => /no paramsDigest is pinned/.test(d.message)));
    });

    it("fails when the view says the grant carries no params at all", async () => {
      const stub = withParams();
      stub.paramsLength = 0;
      await new ExposedAragon("1", stub).validateSection(entry(declared), "acl");

      assert.ok(stats.errorDetails.some((d) => /getPermissionParamsLength is 0/.test(d.message)));
    });
  });
});
