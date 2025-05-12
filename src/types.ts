import { JsonFragment } from "ethers";

export type MethodCallResults = { methodName: string; staticCallResult: string }[];

export type ContractInfo = {
  contractName: string;
  abi: Abi;
  address: string;
  implementation?: ContractInfo;
  proxyType?: string;
  proxy?: string;
  similarMatch?: string;
};

export type Abi = AbiEntry[];

export type AbiEntry<T extends RequiredAbiKeys = RequiredAbiKeys> = T;

type RequiredAbiKeys = Required<Readonly<Pick<JsonFragment, "name" | "type" | "stateMutability" | "inputs">>>;

export function isValidAbi(abi: unknown): abi is Abi {
  return Array.isArray(abi) && abi.every((entry) => _isValidAbiEntry(entry));
}

function _isValidAbiEntry(entry: unknown): entry is AbiEntry {
  if (typeof entry !== "object" || entry === null) return false;

  const object = entry as Partial<AbiEntry>;
  return (
    (typeof object.type === "string" || object.type === undefined) &&
    (typeof object.stateMutability === "string" || object.stateMutability === undefined) &&
    (typeof object.name === "string" || object.name === undefined) &&
    (Array.isArray(object.inputs) || object.inputs === undefined)
  );
}

export type AbiArgumentsLength<T extends AbiKeysForCover = AbiKeysForCover> = {
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

export function isCommonResponseOkResult(object: unknown): object is CommonResponseOkResult {
  return (
    typeof object === "object" &&
    object !== null &&
    "ContractName" in object &&
    typeof object.ContractName === "string" &&
    "ABI" in object &&
    typeof object.ABI === "string"
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
