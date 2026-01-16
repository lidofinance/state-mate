import { assert } from "chai";
import { Contract, JsonRpcProvider } from "ethers";

import { loadAbiFromFile } from "src/abi-provider";
import {
  flushCacheUpdates,
  getCachedRoleHolders,
  getLastScannedBlock,
  RoleHoldersMap,
  saveEventScanToCache,
} from "src/cache-provider";
import { EntryField } from "src/common";
import { buildRoleHoldersFromEvents, mergeRoleHolders, scanRoleEvents } from "src/event-scanner";
import { getContractCreationBlock, loadContract } from "src/explorer-provider";
import { log, LogCommand, logHeader2, WARNING_MARK } from "src/logger";
import { ContractEntry, isTypeOfTB, ProxyContractEntryTB } from "src/typebox";
import { Abi } from "src/types";

import { incChecks, incErrors, SectionValidatorBase, setErrorContext } from "./base";

const DEFAULT_EVENT_BATCH_SIZE = 5000;

export interface ExplorerInfo {
  hostname: string;
  key?: string;
  chainId?: number | string;
}

export class OzNonEnumerableAclSectionValidator extends SectionValidatorBase {
  private explorerInfo?: ExplorerInfo;

  constructor(provider: JsonRpcProvider, explorerInfo?: ExplorerInfo) {
    super(provider, EntryField.ozNonEnumerableAcl);
    this.explorerInfo = explorerInfo;
  }

  override async validateSection(contractEntry: ContractEntry) {
    if (!contractEntry.ozNonEnumerableAcl) {
      return;
    }

    logHeader2(this.sectionName);

    const options = contractEntry.ozNonEnumerableAclOptions;
    const isExhaustive = options?.exhaustive === true;

    await (isExhaustive ? this._validateExhaustive(contractEntry) : this._validate(contractEntry));
  }

  /**
   * For proxy contracts, prefer loading ABI from the implementation address
   * since the proxy delegates calls to the implementation.
   * Falls back to the proxy address ABI if implementation ABI is not available.
   */
  protected _loadAbiWithImplementationFallback(contractEntry: ContractEntry): Abi {
    const { name, address } = contractEntry;

    // Check if this is a proxy contract with an implementation
    if (isTypeOfTB(contractEntry, ProxyContractEntryTB) && contractEntry.implementation) {
      try {
        // Try to load implementation ABI first
        return loadAbiFromFile(name, contractEntry.implementation);
      } catch {
        // Fall back to proxy address ABI
        log(`  (Using proxy ABI as implementation ABI for ${name} at ${contractEntry.implementation} was not found)`);
      }
    }

    return loadAbiFromFile(name, address);
  }

  /**
   * Non-exhaustive validation: only checks configured role-holder pairs
   */
  protected async _validate(contractEntry: ContractEntry) {
    const abi = this._loadAbiWithImplementationFallback(contractEntry);
    const contract = loadContract(contractEntry.address, abi, this.provider);

    log(
      `${WARNING_MARK}: Non-enumerable OZ Acl means it is impossible to check absence of an arbitrary role holder ` +
        `only by means of calling view function. Current version of state-mate does what it can at most: for all the ` +
        `role holders specified checks they do not hold roles they are not described to have among all the roles mentioned.`,
    );

    const rolesByHolders = new Map<string, Set<string>>();
    for (const role in contractEntry.ozNonEnumerableAcl) {
      for (const holder of contractEntry.ozNonEnumerableAcl[role]) {
        incChecks();
        if (!rolesByHolders.has(holder)) {
          rolesByHolders.set(holder, new Set<string>());
        }
        rolesByHolders.get(holder)?.add(role);
        const methodName = `.hasRole(${role}, ${holder})`;
        const logHandle = new LogCommand(methodName);
        setErrorContext({ method: methodName });
        try {
          const isRoleOnHolder: unknown = await contract.getFunction("hasRole").staticCall(role, holder);
          assert.isTrue(isRoleOnHolder);
          logHandle.success(`${isRoleOnHolder}`);
        } catch (error) {
          const errorMessage = `REVERTED with: ${(error as Error).message}`;
          logHandle.failure(errorMessage);
          incErrors(errorMessage);
        }
      }
    }

    for (const [holder, rolesExpectedOnTheHolder] of rolesByHolders) {
      for (const role in contractEntry.ozNonEnumerableAcl) {
        if (!rolesExpectedOnTheHolder.has(role)) {
          incChecks();
          const methodName = `.hasRole(${role}, ${holder})`;
          const logHandle = new LogCommand(methodName);
          setErrorContext({ method: methodName });
          try {
            const isRoleOnHolder: unknown = await contract.getFunction("hasRole").staticCall(role, holder);
            assert.isFalse(isRoleOnHolder);
            logHandle.success(`${isRoleOnHolder}`);
          } catch (error) {
            const errorMessage = `REVERTED with: ${(error as Error).message}`;
            logHandle.failure(errorMessage);
            incErrors(errorMessage);
          }
        }
      }
    }
  }

  /**
   * Exhaustive validation: scans events to detect ALL role holders
   */
  private async _validateExhaustive(contractEntry: ContractEntry) {
    const { address } = contractEntry;
    const eventAddress = address; // Events are emitted from proxy address where storage lives
    const batchSize = contractEntry.ozNonEnumerableAclOptions?.eventBatchSize ?? DEFAULT_EVENT_BATCH_SIZE;

    log(`  Performing exhaustive ACL check via event scanning...`);

    // Check if we have explorer info for fetching creation block
    if (!this.explorerInfo?.hostname) {
      log(
        `${WARNING_MARK}: No explorer configured. Cannot perform exhaustive check. Falling back to non-exhaustive check.`,
      );
      await this._validate(contractEntry);
      return;
    }

    // Get contract creation block
    const creationInfo = await getContractCreationBlock(
      eventAddress,
      this.explorerInfo.hostname,
      this.provider,
      this.explorerInfo.key,
      this.explorerInfo.chainId,
    );

    if (!creationInfo) {
      log(`${WARNING_MARK}: Could not determine contract creation block. Falling back to non-exhaustive check.`);
      await this._validate(contractEntry);
      return;
    }

    log(`  Contract deployed at block ${creationInfo.blockNumber}`);

    // Get current block
    const currentBlock = await this.provider.getBlockNumber();

    // Check cache and perform incremental scan if needed
    let roleHolders: RoleHoldersMap;
    const lastScannedBlock = getLastScannedBlock(eventAddress);
    const cachedRoleHolders = getCachedRoleHolders(eventAddress);

    if (cachedRoleHolders && lastScannedBlock !== null && lastScannedBlock >= currentBlock) {
      log(`  Using cached event scan results (up to block ${lastScannedBlock})`);
      roleHolders = cachedRoleHolders;
    } else if (cachedRoleHolders && lastScannedBlock !== null && lastScannedBlock >= creationInfo.blockNumber) {
      // Incremental scan from last scanned block
      log(`  Performing incremental scan from block ${lastScannedBlock + 1} to ${currentBlock}...`);
      const { events, toBlock } = await scanRoleEvents(this.provider, eventAddress, {
        batchSize,
        fromBlock: lastScannedBlock + 1,
        toBlock: currentBlock,
      });
      log(`  Found ${events.length} new role events`);

      roleHolders = mergeRoleHolders(cachedRoleHolders, events);
      saveEventScanToCache(eventAddress, roleHolders, toBlock);
      flushCacheUpdates();
    } else {
      // Full scan from deployment
      log(`  Scanning events from block ${creationInfo.blockNumber} to ${currentBlock}...`);
      const { events, toBlock } = await scanRoleEvents(this.provider, eventAddress, {
        batchSize,
        fromBlock: creationInfo.blockNumber,
        toBlock: currentBlock,
      });
      log(`  Found ${events.length} role events`);

      roleHolders = buildRoleHoldersFromEvents(events);
      saveEventScanToCache(eventAddress, roleHolders, toBlock);
      flushCacheUpdates();
    }

    // Compare with config
    await this._compareRoleHolders(contractEntry, roleHolders);
  }

  /**
   * Compare actual role holders (from events) against configured role holders
   */
  private async _compareRoleHolders(contractEntry: ContractEntry, actualRoleHolders: RoleHoldersMap) {
    const abi = this._loadAbiWithImplementationFallback(contractEntry);
    const contract = loadContract(contractEntry.address, abi, this.provider);

    const expectedRoles = contractEntry.ozNonEnumerableAcl!;
    const allConfiguredRoles = new Set(Object.keys(expectedRoles));

    // Check each configured role
    for (const role of allConfiguredRoles) {
      const expectedHolders = new Set(expectedRoles[role].map((h) => h.toLowerCase()));
      const actualHolders = actualRoleHolders.get(role) ?? new Set();

      log(`  Role: ${role}`);
      log(`    Expected holders: ${expectedRoles[role].length}, Actual holders from events: ${actualHolders.size}`);

      // Check expected holders are present
      for (const expectedHolder of expectedHolders) {
        await this._verifyHolderHasRole(contract, role, expectedHolder, true);
      }

      // Check for UNEXPECTED holders (the key feature!)
      for (const actualHolder of actualHolders) {
        if (!expectedHolders.has(actualHolder)) {
          await this._checkUnexpectedHolder(contract, role, actualHolder);
        }
      }
    }

    // Check for roles in events but not in config
    for (const [role, holders] of actualRoleHolders) {
      if (!allConfiguredRoles.has(role) && holders.size > 0) {
        log(`${WARNING_MARK}: Unconfigured role ${role} has ${holders.size} holder(s):`);
        for (const holder of holders) {
          // Verify on-chain
          const hasRole = await this._checkHasRole(contract, role, holder);
          if (hasRole) {
            log(`    - ${holder} (confirmed on-chain)`);
            incChecks();
            incErrors(`Unconfigured role ${role} has unexpected holder: ${holder}`);
          }
        }
      }
    }
  }

  private async _verifyHolderHasRole(
    contract: Contract,
    role: string,
    holder: string,
    expected: boolean,
  ): Promise<void> {
    incChecks();
    const methodName = `.hasRole(${role}, ${holder})`;
    const logHandle = new LogCommand(methodName);
    setErrorContext({ method: methodName });

    try {
      const hasRole = await contract.getFunction("hasRole").staticCall(role, holder);
      if (hasRole === expected) {
        logHandle.success(`${hasRole}`);
      } else {
        const errorMessage = expected
          ? `Expected holder ${holder} to have role but hasRole returned false`
          : `Expected holder ${holder} to NOT have role but hasRole returned true`;
        logHandle.failure(errorMessage);
        incErrors(errorMessage);
      }
    } catch (error) {
      const errorMessage = `REVERTED with: ${(error as Error).message}`;
      logHandle.failure(errorMessage);
      incErrors(errorMessage);
    }
  }

  private async _checkUnexpectedHolder(contract: Contract, role: string, holder: string): Promise<void> {
    incChecks();
    const methodName = `UNEXPECTED .hasRole(${role}, ${holder})`;
    const logHandle = new LogCommand(methodName);
    setErrorContext({ method: methodName });

    try {
      const hasRole = await contract.getFunction("hasRole").staticCall(role, holder);
      if (hasRole) {
        const errorMessage = `UNEXPECTED role holder found: ${holder} has role ${role}`;
        logHandle.failure(errorMessage);
        incErrors(errorMessage);
      } else {
        // Role was granted but later revoked - not an error
        logHandle.success(`false (role was revoked)`);
      }
    } catch (error) {
      const errorMessage = `REVERTED with: ${(error as Error).message}`;
      logHandle.failure(errorMessage);
      incErrors(errorMessage);
    }
  }

  private async _checkHasRole(contract: Contract, role: string, holder: string): Promise<boolean> {
    try {
      return await contract.getFunction("hasRole").staticCall(role, holder);
    } catch {
      return false;
    }
  }
}
