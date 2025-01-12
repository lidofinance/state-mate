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

export const MaxIntFormat = {
  name: "max-int",
  formatString: /^\d{78}$/,
};

FormatRegistry.Set(
  EthereumAddressFormat.name,
  (value) => typeof value === "string" && EthereumAddressFormat.formatString.test(value),
);

FormatRegistry.Set(
  EthereumRoleFormat.name,
  (value) => typeof value === "string" && EthereumRoleFormat.formatString.test(value),
);

FormatRegistry.Set(MaxIntFormat.name, (value) => typeof value === "string" && MaxIntFormat.formatString.test(value));

const EthAddressStringTB = Type.Readonly(
  Type.String({ format: EthereumAddressFormat.name, pattern: EthereumAddressFormat.formatString.source }),
);
const EthRoleStringTB = Type.Readonly(
  Type.String({ format: EthereumRoleFormat.name, pattern: EthereumRoleFormat.formatString.source }),
);

const MaxIntStringTB = Type.Readonly(
  Type.String({ format: MaxIntFormat.name, pattern: MaxIntFormat.formatString.source }),
);

const EthAddressesArrayTB = Type.Readonly(Type.Array(EthAddressStringTB));
const EthRolesArrayTB = Type.Readonly(Type.Array(EthRoleStringTB));
export type EntireDocument = Static<typeof EntireDocumentTB>;
export type SeedDocument = Static<typeof SeedDocumentTB>;
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

const ViewResultPlainValueTB = Type.Readonly(Type.Union([Type.Null(), Type.String(), Type.Boolean(), Type.Number()]));
const ArrayPlainValue = Type.Readonly(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean()])));

const ArbitraryObjectTB = Type.Readonly(Type.Record(Type.String(), ViewResultPlainValueTB));

export const ViewResultTB = Type.Readonly(
  Type.Union([ViewResultPlainValueTB, ArbitraryObjectTB, ArrayPlainValue, Type.Array(ArrayPlainValue)]),
);

const StaticCallCommon = Type.Readonly(
  Type.Object({
    args: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean()]))),
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
      proxy__getImplementation: Type.Optional(EthAddressStringTB),
      proxy__getAdmin: Type.Optional(EthAddressStringTB),
      proxy__getIsOssified: Type.Optional(Type.Boolean()),
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
      explorerHostname: Type.Optional(Type.String()),
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
      l2: Type.Optional(EthAddressesArrayTB),
    },
    { additionalProperties: false },
  ),
);

export const EntireDocumentTB = Type.Readonly(
  Type.Object(
    {
      parameters: Type.Array(Type.Union([EthAddressStringTB, Type.Literal(0), EthRoleStringTB, MaxIntStringTB])),
      roles: Type.Optional(Type.Union([Type.Array(EthRoleStringTB), Type.Null()])),
      misc: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number()]))),
      deployed: DeployedSectionTB,
      "deployed-aux": Type.Optional(EthRolesArrayTB),
      l1: NetworkSectionTB,
      l2: Type.Optional(NetworkSectionTB),
      tvl: Type.Optional(Type.Array(Type.Number())),
      delays: Type.Optional(Type.Array(Type.String())),
      signers: Type.Optional(Type.Array(Type.Union([EthAddressStringTB, Type.Number()]))),
      selectors: Type.Optional(Type.Array(Type.String())),
      validators: Type.Optional(Type.Array(Type.String())),
    },
    { additionalProperties: false },
  ),
);

export const SeedDocumentTB = Type.Readonly(
  Type.Object(
    {
      deployed: DeployedSectionTB,
      l1: ExplorerSectionTB,
      l2: Type.Optional(ExplorerSectionTB),
    },
    { additionalProperties: false },
  ),
);
