import { FormatRegistry, Static, TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const EthereumAddressFormat = {
  name: "ethereum-address",
  formatString: /^0x[a-fA-F0-9]{40}$/,
};

export const EthereumRoleFormat = {
  name: "ethereum-role",
  formatString: /^0x[a-fA-F0-9]{64}$/,
};

FormatRegistry.Set(
  EthereumAddressFormat.name,
  (value) => typeof value === "string" && EthereumAddressFormat.formatString.test(value),
);
FormatRegistry.Set(
  EthereumRoleFormat.name,
  (value) => typeof value === "string" && EthereumAddressFormat.formatString.test(value),
);

const EthAddressStringTB = Type.Readonly(Type.String({ format: EthereumAddressFormat.name }));
const EthRoleStringTB = Type.Readonly(Type.String({ format: EthereumRoleFormat.name }));
const EthAddressesArrayTB = Type.Readonly(Type.Array(EthAddressStringTB));

export type EntireDocument = Static<typeof EntireDocumentTB>;
export type ContractEntry = Static<typeof ContractEntryTB>;
export type ProxyContractEntry = Static<typeof ProxyContractEntryTB>;
export type RegularContractEntry = Static<typeof RegularContractEntryTB>;
export type StaticCallCheck = Static<typeof StaticCallCheckTB>;
export type ViewResultPlainValue = Static<typeof ViewResultPlainValueTB>;
export type ArbitraryObject = Static<typeof ArbitraryObjectTB>;
export type ViewResult = Static<typeof ViewResultTB>;
// export type ExplorerSection = Static<typeof ExplorerSectionTB>
export type NetworkSection = Static<typeof NetworkSectionTB>;
export type StaticCallMustRevert = Static<typeof StaticCallMustRevertTB>;
export type StaticCallResult = Static<typeof StaticCallResultTB>;
export type RegularChecks = Static<typeof RegularChecksTB>;
export type ChecksEntryValue = Static<typeof ChecksEntryValueTB>;
export type ContractSection = Static<typeof ContractSectionTB>;
export type DeployedSection = Static<typeof DeployedSectionTB>;
export type EthAddressString = Static<typeof EthAddressStringTB>;
export function isTypeOfTB<T extends TSchema>(value: unknown, schema: T): value is Static<typeof schema> {
  return Value.Check(schema, value);
}

const OzNonEnumerableAclTB = Type.Readonly(Type.Record(EthRoleStringTB, EthAddressesArrayTB));

const ViewResultPlainValueTB = Type.Readonly(
  Type.Union([Type.Null(), Type.String(), Type.Boolean(), Type.Number(), Type.Array(Type.String())]),
);

const ArbitraryObjectTB = Type.Readonly(Type.Record(Type.String(), ViewResultPlainValueTB));

export const ViewResultTB = Type.Readonly(Type.Union([ViewResultPlainValueTB, ArbitraryObjectTB]));

const StaticCallCommon = Type.Readonly(
  Type.Object({
    args: Type.Optional(Type.Array(Type.String())),
    signature: Type.Optional(Type.String()),
    bigint: Type.Optional(Type.Boolean()),
  }),
);

//intersect not correctly works with {additionalProperties: false }
export const StaticCallResultTB = Type.Readonly(
  Type.Object(
    {
      ...StaticCallCommon.properties,
      result: ViewResultTB,
    },
    { additionalProperties: false },
  ),
);

export const StaticCallMustRevertTB = Type.Readonly(
  Type.Object(
    {
      ...StaticCallCommon.properties,
      mustRevert: Type.Literal(true),
    },
    { additionalProperties: false },
  ),
);

export const StaticCallCheckTB = Type.Readonly(Type.Union([StaticCallResultTB, StaticCallMustRevertTB]));

export const ArrayOfStaticCallCheckTB = Type.Readonly(Type.Array(StaticCallCheckTB));

const ChecksEntryValueTB = Type.Readonly(Type.Union([StaticCallCheckTB, ViewResultTB, ArrayOfStaticCallCheckTB]));

export const ProxyChecksTB = Type.Readonly(
  Type.Object(
    {
      proxy__getImplementation: EthAddressStringTB,
      proxy__getAdmin: EthAddressStringTB,
      proxy__getIsOssified: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
);

export const RegularChecksTB = Type.Readonly(Type.Record(Type.String(), ChecksEntryValueTB));

const ImplementationChecksTB = Type.Optional(RegularChecksTB);

export const RegularContractEntryTB = Type.Readonly(
  Type.Object(
    {
      address: EthAddressStringTB,
      name: Type.String(),
      checks: RegularChecksTB,
      ozNonEnumerableAcl: Type.Optional(OzNonEnumerableAclTB),
    },
    { additionalProperties: false },
  ),
);

export const ProxyContractEntryTB = Type.Readonly(
  Type.Object(
    {
      ...RegularContractEntryTB.properties,
      proxyName: Type.String(),
      implementation: Type.Optional(EthAddressStringTB),
      proxyChecks: Type.Optional(ProxyChecksTB),
      implementationChecks: ImplementationChecksTB,
    },
    { additionalProperties: false },
  ),
);

export const ContractEntryTB = Type.Readonly(Type.Union([RegularContractEntryTB, ProxyContractEntryTB]));

export const ExplorerSectionTB = Type.Readonly(
  Type.Object(
    {
      rpcUrl: Type.String(),
      explorerHostname: Type.String(),
      explorerTokenEnv: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
);

const ContractSectionTB = Type.Readonly(Type.Record(Type.String(), ContractEntryTB));

export const NetworkSectionTB = Type.Readonly(
  Type.Object(
    {
      ...ExplorerSectionTB.properties,
      contracts: ContractSectionTB,
    },
    { additionalProperties: false },
  ),
);

const DeployedSectionTB = Type.Readonly(
  Type.Object(
    {
      l1: EthAddressesArrayTB,
      l2: EthAddressesArrayTB,
    },
    { additionalProperties: false },
  ),
);

export const EntireDocumentTB = Type.Readonly(
  Type.Object(
    {
      parameters: EthAddressesArrayTB,
      roles: Type.Array(EthRoleStringTB),
      misc: Type.Optional(EthAddressesArrayTB),
      deployed: DeployedSectionTB,
      l1: NetworkSectionTB,
      l2: NetworkSectionTB,
    },
    { additionalProperties: false },
  ),
);

export const SeedDocumentTB = Type.Readonly(
  Type.Object(
    {
      deployed: DeployedSectionTB,
      l1: ExplorerSectionTB,
      l2: ExplorerSectionTB,
    },
    { additionalProperties: false },
  ),
);
