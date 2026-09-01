import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

import type { Contract, JsonRpcProvider } from "ethers";

import {
  ANY_ENTITY,
  type AragonEvent,
  CHANGE_PERMISSION_MANAGER_TOPIC,
  EMPTY_PARAM_HASH,
  managerSlot,
  paramsDigest,
  permissionSlot,
  SET_PERMISSION_TOPIC,
} from "../src/acl/aragon";
import { context, resetStats, stats } from "../src/context";
import { resetRequestSlots } from "../src/explorer";
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
    stub.slots![managerSlot(LIDO, MSK)] = word(VOTING);
    await new ExposedAragon("1", stub).validateSection(entry(DECLARED), "acl");

    assert.ok(stats.errorDetails.some((d) => /has manager .* but is not declared/.test(d.message)));
  });

  it("clears an undeclared manager event the manager slot does not corroborate", async () => {
    const stub = healthyStub();
    stub.events.push(manager(LIDO, MSK, VOTING, 6)); // no slot backing: stale or fabricated
    await new ExposedAragon("1", stub).validateSection(entry(DECLARED), "acl");

    assert.equal(stats.errors, 0);
  });

  // the review finding on the OZ scan, applied here: events nominate, storage decides, so a
  // fabricated revocation cannot pull a live holder out of the candidate set
  it("still reports an undeclared holder whose revocation the source invented", async () => {
    const stub = healthyStub();
    stub.events.push(grant(STRANGER, SDVT, MSK, 5), {
      allowed: false,
      app: SDVT,
      blockNumber: 6,
      entity: STRANGER,
      kind: "permission",
      logIndex: 0,
      role: MSK,
    });
    stub.slots![permissionSlot(STRANGER, SDVT, MSK)] = EMPTY_PARAM_HASH; // the chain still holds it
    await new ExposedAragon("1", stub).validateSection(entry(DECLARED), "acl");

    assert.equal(stats.errors, 1);
    assert.match(stats.errorDetails[0].message, /undeclared unconditional permission/);
  });

  it("still reports an undeclared live manager whose removal the source invented", async () => {
    const stub = healthyStub();
    stub.events.push(manager(LIDO, MSK, VOTING, 6), manager(LIDO, MSK, `0x${"0".repeat(40)}`, 7));
    stub.slots![managerSlot(LIDO, MSK)] = word(VOTING); // slot 2 still holds the manager
    await new ExposedAragon("1", stub).validateSection(entry(DECLARED), "acl");

    assert.equal(stats.errors, 1);
    assert.match(stats.errorDetails[0].message, /has manager .* but is not declared/);
  });

  // granted means exactly these, not at least these: an extra live grantee on a role the config
  // does declare is the highest-privilege thing this section can miss (review finding on this PR)
  it("reports a live unconditional grantee a declared role's granted list does not include", async () => {
    const stub = healthyStub();
    stub.events.push(grant(VOTING, LIDO, ROLE, 5));
    stub.slots![permissionSlot(VOTING, LIDO, ROLE)] = EMPTY_PARAM_HASH;
    await new ExposedAragon("1", stub).validateSection(entry(DECLARED), "acl");

    assert.equal(stats.errors, 1);
    assert.match(stats.errorDetails[0].message, /live unconditional grant to .* is not declared/);
  });

  it("still reports the extra grantee on a declared role when its revocation was fabricated", async () => {
    const stub = healthyStub();
    stub.events.push(grant(VOTING, LIDO, ROLE, 5), {
      allowed: false,
      app: LIDO,
      blockNumber: 6,
      entity: VOTING,
      kind: "permission",
      logIndex: 0,
      role: ROLE,
    });
    stub.slots![permissionSlot(VOTING, LIDO, ROLE)] = EMPTY_PARAM_HASH; // the chain still holds it
    await new ExposedAragon("1", stub).validateSection(entry(DECLARED), "acl");

    assert.equal(stats.errors, 1);
    assert.match(stats.errorDetails[0].message, /live unconditional grant to .* is not declared/);
  });

  it("clears an extra grantee on a declared role that storage does not corroborate", async () => {
    const stub = healthyStub();
    stub.events.push(grant(VOTING, LIDO, ROLE, 5)); // no slot backing: stale or fabricated
    await new ExposedAragon("1", stub).validateSection(entry(DECLARED), "acl");

    assert.equal(stats.errors, 0);
  });

  it("reports a live ANY_ENTITY grant on a declared role", async () => {
    const stub = healthyStub();
    stub.events.push(grant(ANY_ENTITY, LIDO, ROLE, 5));
    stub.slots![permissionSlot(ANY_ENTITY, LIDO, ROLE)] = EMPTY_PARAM_HASH;
    await new ExposedAragon("1", stub).validateSection(entry(DECLARED), "acl");

    assert.equal(stats.errors, 1);
    assert.match(stats.errorDetails[0].message, /granted to everyone/);
  });

  it("reports a live ANY_ENTITY grant on an undeclared role as the wildcard, not a plain extra", async () => {
    const stub = healthyStub();
    stub.events.push(grant(ANY_ENTITY, SDVT, MSK, 5));
    stub.slots![permissionSlot(ANY_ENTITY, SDVT, MSK)] = EMPTY_PARAM_HASH;
    await new ExposedAragon("1", stub).validateSection(entry(DECLARED), "acl");

    assert.equal(stats.errors, 1);
    assert.match(stats.errorDetails[0].message, /granted to everyone/);
  });

  it("refuses a config that declares ANY_ENTITY as a grantee", async () => {
    const stub = healthyStub();
    const declared = { [LIDO]: { [ROLE]: { granted: [AGENT, ANY_ENTITY], manager: AGENT } } };
    await new ExposedAragon("1", stub).validateSection(entry(declared), "acl");

    assert.equal(stats.errors, 1);
    assert.match(stats.errorDetails[0].message, /wildcard may not be declared/);
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

    // grantPermission() overwrites a conditional grant with an unconditional one and emits no
    // params event (aragonOS _setPermission); the stale hash must not make the events-side
    // digest disagree with a chain that is in fact correct
    it("passes a declared grantee whose conditional grant was replaced by an unconditional one", async () => {
      const stub = withParams();
      stub.events.push(
        grant(VOTING, LIDO, MSK, 6),
        params(VOTING, LIDO, MSK, HASH_A, 6),
        grant(VOTING, LIDO, MSK, 7), // the replacement: SetPermission(true), no params event
      );
      stub.hasPermission![`${VOTING}|${LIDO}|${MSK}`] = true;
      stub.slots![permissionSlot(VOTING, LIDO, MSK)] = EMPTY_PARAM_HASH;
      const withGrantee = {
        [LIDO]: {
          [ROLE]: { granted: [AGENT], manager: AGENT },
          [MSK]: { granted: [VOTING], manager: AGENT, paramsDigest: pinned },
        },
      };
      await new ExposedAragon("1", stub).validateSection(entry(withGrantee), "acl");

      assert.equal(stats.errors, 0);
    });

    // the digest's live set is decided by the slots, not the events, so a fabricated revocation
    // cannot thin it: the hidden holder still reads back and breaks the slots-side fold
    it("reports a live parameterized holder the pin does not cover when its revocation was fabricated", async () => {
      const stub = withParams();
      stub.events.push(grant(VOTING, LIDO, MSK, 6), params(VOTING, LIDO, MSK, HASH_A, 6), {
        allowed: false,
        app: LIDO,
        blockNumber: 7,
        entity: VOTING,
        kind: "permission",
        logIndex: 0,
        role: MSK,
      });
      stub.slots![permissionSlot(VOTING, LIDO, MSK)] = HASH_A; // the chain still holds it
      await new ExposedAragon("1", stub).validateSection(entry(declared), "acl");

      assert.ok(stats.errorDetails.some((d) => /slots to/.test(d.message)));
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

describe("the RPC tail in the real scan", () => {
  beforeEach(() => {
    resetStats();
    resetContractCounters();
    context.quiet = true;
  });

  /** Only the view surface is stubbed; _scan runs for real against the mocked explorer and RPC. */
  class TailAragon extends AragonAclSectionValidator {
    protected override _aclContract(): Contract {
      return {
        getFunction: (name: string) => ({
          staticCall: (...args: string[]) => {
            if (name === "hasPermission")
              return Promise.resolve(args.join("|").toLowerCase() === `${AGENT}|${LIDO}|${ROLE}`);
            if (name === "getPermissionManager") return Promise.resolve(AGENT);
            return Promise.resolve(1);
          },
        }),
      } as unknown as Contract;
    }
  }

  // the review finding: the scan stopped at the settled head while views and storage read the
  // latest block, so a grant landed in the confirmation-lag window passed with zero errors --
  // a blind spot on exactly the schedule an attacker gets to pick
  it("discovers and reports a grant that exists only in the unsettled tail", async () => {
    const TRUE_WORD = `0x${"0".repeat(63)}1`;
    const padded = (address: string) => `0x${"0".repeat(24)}${address.slice(2)}`;
    const slots: Record<string, string> = {
      [permissionSlot(AGENT, LIDO, ROLE)]: EMPTY_PARAM_HASH,
      [managerSlot(LIDO, ROLE)]: word(AGENT),
      [permissionSlot(VOTING, LIDO, ROLE)]: EMPTY_PARAM_HASH, // live, but only the tail saw it
    };
    const explorerAsked: number[] = [];
    const tailAsked: unknown[] = [];

    const provider = {
      getBlockNumber: async () => 1000,
      getLogs: async (filter: { fromBlock: number; toBlock: number }) => {
        tailAsked.push({ fromBlock: filter.fromBlock, toBlock: filter.toBlock });
        return [
          {
            address: ACL,
            blockNumber: 997,
            data: TRUE_WORD,
            index: 0,
            topics: [SET_PERMISSION_TOPIC, padded(VOTING), padded(LIDO), ROLE],
          },
        ];
      },
      getStorage: async (_a: string, slot: string) => slots[slot.toLowerCase()] ?? ZERO_WORD,
    } as unknown as JsonRpcProvider;

    resetRequestSlots();
    const fetchMock = mock.method(globalThis, "fetch", async (input: unknown) => {
      const url = String(input);
      if (url.includes("getcontractcreation")) {
        return Response.json({ result: [{ blockNumber: "1", contractAddress: ACL }], status: "1" });
      }
      explorerAsked.push(Number(/toBlock=(\d+)/.exec(url)?.[1]));
      if (url.includes(`topic0=${SET_PERMISSION_TOPIC}`)) {
        return Response.json({
          result: [
            {
              address: ACL,
              blockNumber: "0x5",
              data: TRUE_WORD,
              logIndex: "0x0",
              topics: [SET_PERMISSION_TOPIC, padded(AGENT), padded(LIDO), ROLE],
            },
          ],
          status: "1",
        });
      }
      if (url.includes(`topic0=${CHANGE_PERMISSION_MANAGER_TOPIC}`)) {
        return Response.json({
          result: [
            {
              address: ACL,
              blockNumber: "0x5",
              data: "0x",
              logIndex: "0x1",
              topics: [CHANGE_PERMISSION_MANAGER_TOPIC, padded(LIDO), ROLE, padded(AGENT)],
            },
          ],
          status: "1",
        });
      }
      return Response.json({ message: "No records found", result: "No records found", status: "0" });
    });

    try {
      await new TailAragon(provider, "1").validateSection(entry(DECLARED), "acl");
    } finally {
      fetchMock.mock.restore();
      resetRequestSlots();
    }

    // the explorer covers only the settled range; the RPC is asked for exactly the tail
    assert.ok(explorerAsked.every((toBlock) => toBlock === 992));
    assert.deepEqual(tailAsked, [{ fromBlock: 993, toBlock: 1000 }]);
    // the grant at block 997 was invisible before the tail fill; now it is found and reported
    assert.equal(stats.errors, 1);
    assert.match(stats.errorDetails[0].message, /live unconditional grant to .* is not declared/);
  });
});
