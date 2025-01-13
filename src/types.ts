import { JsonFragment } from "ethers";
import { Scalar } from "yaml";

export type MethodCallResults = { methodName: string; staticCallResult: string }[];

export type DeployedAddressInfo = {
  deployedNode: Scalar;
  sectionName: string;
  address: string;
  rpcUrl: string;
  explorerHostname: string;
  explorerKey?: string;
};

export type ContractInfo = {
  contractName: string;
  abi: Abi;
  address: string;
  implementation?: ContractInfo;
};

export type Abi = AbiEntry[];

type AbiEntry<T extends RequiredAbiKeys = RequiredAbiKeys> = T;

type RequiredAbiKeys = Required<Readonly<Pick<JsonFragment, "name" | "type" | "stateMutability" | "inputs">>>;

function isValidAbiEntry(entry: unknown): entry is AbiEntry {
  if (typeof entry !== "object" || entry === null) return false;

  const obj = entry as Partial<AbiEntry>;
  return (
    (typeof obj.type === "string" || obj.type === undefined) &&
    (typeof obj.stateMutability === "string" || obj.stateMutability === undefined) &&
    (typeof obj.name === "string" || obj.name === undefined) &&
    (Array.isArray(obj.inputs) || obj.inputs === undefined)
  );
}

export function isValidAbi(abi: unknown): abi is Abi {
  return Array.isArray(abi) && abi.every(isValidAbiEntry);
}

export type AbiArgsLength<T extends AbiKeysForCover = AbiKeysForCover> = {
  name: T["name"];
  numArgs: T["inputs"] extends { length: number } ? number : never;
}[];

type AbiKeysForCover = Required<Pick<RequiredAbiKeys, "name" | "inputs">>;

export type ResponseOk = {
  status: "1";
  message: string;
  result: CommonResponseOkResult[];
};

export type CommonResponseOkResult = {
  ABI: string;
  ContractName: string;
};

export type ResponseBad = {
  status: "0";
  message: string;
  result: string;
};

export function isResponseOk(response: unknown): response is ResponseOk {
  return (
    typeof response === "object" &&
    response !== null &&
    "status" in response &&
    response.status === "1" &&
    "message" in response &&
    response.message === "OK" &&
    "result" in response &&
    Array.isArray(response.result)
  );
}

export function isCommonResponseOkResult(obj: unknown): obj is CommonResponseOkResult {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "ContractName" in obj &&
    typeof obj.ContractName === "string" &&
    "ABI" in obj &&
    typeof obj.ABI === "string"
  );
}

export function isResponseBad(response: unknown): response is ResponseBad {
  return (
    typeof response === "object" &&
    response !== null &&
    "status" in response &&
    response.status === "0" &&
    "result" in response &&
    typeof response.result === "string"
  );
}
