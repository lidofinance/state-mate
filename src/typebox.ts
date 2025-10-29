import { FormatRegistry, Static, TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const EthereumStringFormat = {
  name: "ethereum-string",
  formatString: /^(0x[a-fA-F0-9]{40}|0x[a-fA-F0-9]{64}|.+)$/,
};

export const MaxIntFormat = {
  name: "max-int",
  formatString: /^\d{78}$/,
};

FormatRegistry.Set(
  EthereumStringFormat.name,
  (value) => typeof value === "string" && EthereumStringFormat.formatString.test(value),
);

FormatRegistry.Set(MaxIntFormat.name, (value) => typeof value === "string" && MaxIntFormat.formatString.test(value));

const EthereumStringTB = Type.Readonly(
  Type.String({ format: EthereumStringFormat.name, pattern: EthereumStringFormat.formatString.source }),
);

const EthereumStringArrayTB = Type.Readonly(Type.Array(EthereumStringTB));

export type EntireDocument = Static<typeof EntireDocumentTB>;
export type SeedDocument = Static<typeof SeedDocumentTB>;
export type ContractEntry = Static<typeof ContractEntryTB>;
export type StaticCallCheck = Static<typeof StaticCallCheckTB>;
export type ArbitraryObject = Static<typeof ArbitraryObjectTB>;
export type ViewResult = Static<typeof ViewResultTB>;
export type NetworkSection = Static<typeof NetworkSectionTB>;
export type StaticCallMustRevert = Static<typeof StaticCallMustRevertTB>;
export type StaticCallResult = Static<typeof StaticCallResultTB>;
export type RegularChecks = Static<typeof RegularChecksTB>;
export type ChecksEntryValue = Static<typeof ChecksEntryValueTB>;

export function isTypeOfTB<T extends TSchema>(value: unknown, schema: T): value is Static<typeof schema> {
  return Value.Check(schema, value);
}

const OzNonEnumerableAclTB = Type.Readonly(Type.Record(EthereumStringTB, EthereumStringArrayTB));

export const PlainValueTB = Type.Readonly(Type.Union([Type.Null(), Type.String(), Type.Boolean(), Type.Number()]));
export const PlainValueArrayTB = Type.Readonly(Type.Array(PlainValueTB));
const PlainValueOrArray = Type.Readonly(Type.Array(Type.Union([PlainValueTB, PlainValueArrayTB])));

export const ArgumentsTB = Type.Readonly(Type.Array(Type.Union([PlainValueTB, PlainValueArrayTB])));

const ArbitraryObjectTB = Type.Readonly(Type.Record(Type.String(), PlainValueTB));

export const ViewResultTB = Type.Readonly(Type.Union([PlainValueTB, ArgumentsTB, ArbitraryObjectTB]));

const StaticCallCommon = Type.Readonly(
  Type.Object({
    args: Type.Optional(ArgumentsTB),
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

const ChecksEntryValueTB = Type.Readonly(
  Type.Union([StaticCallCheckTB, ViewResultTB, ArgumentsTB, ArrayOfStaticCallCheckTB]),
);

const ProxyChecksTB = Type.Readonly(
  Type.Union([
    Type.Object(
      {
        proxy__getImplementation: Type.Optional(Type.Union([EthereumStringTB, Type.Null()])),
        proxy__getAdmin: Type.Optional(Type.Union([EthereumStringTB, Type.Null()])),
        proxy__getIsOssified: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        implementation: Type.Optional(Type.Union([EthereumStringTB, Type.Null()])),
        proxy_getAdmin: Type.Optional(Type.Union([EthereumStringTB, Type.Null()])),
        proxy_getIsOssified: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
      },
      { additionalProperties: false },
    ),
  ]),
);

const Sr2ProxyChecksTB = Type.Readonly(
  Type.Object(
    {
      proxyType: PlainValueTB,
      isDepositable: PlainValueTB,
      implementation: EthereumStringTB,
      appId: PlainValueTB,
      kernel: PlainValueTB,
    },
    { additionalProperties: false },
  ),
);

const AragonProxyChecksTB = Type.Readonly(
  Type.Object(
    {
      proxyType: PlainValueTB,
      apps: PlainValueTB,
      isDepositable: PlainValueTB,
      implementation: EthereumStringTB,
      recoveryVaultAppId: EthereumStringTB,
    },
    { additionalProperties: false },
  ),
);

const RegularChecksTB = Type.Readonly(Type.Record(Type.String(), ChecksEntryValueTB));

const ImplementationChecksTB = Type.Optional(RegularChecksTB);

const OzAclChecksTB = Type.Readonly(Type.Record(Type.String(), EthereumStringArrayTB, { additionalProperties: false }));

const RegularContractEntryTB = Type.Readonly(
  Type.Object(
    {
      address: EthereumStringTB,
      name: Type.String(),
      checks: RegularChecksTB,
      ozNonEnumerableAcl: Type.Optional(OzNonEnumerableAclTB),
      ozAcl: Type.Optional(OzAclChecksTB),
    },
    { additionalProperties: false },
  ),
);

export const ProxyContractEntryTB = Type.Readonly(
  Type.Object(
    {
      ...RegularContractEntryTB.properties,
      proxyName: Type.String(),
      implementation: Type.Optional(EthereumStringTB),
      proxyChecks: Type.Optional(Type.Union([ProxyChecksTB, Sr2ProxyChecksTB, AragonProxyChecksTB])),
      implementationChecks: ImplementationChecksTB,
    },
    { additionalProperties: false },
  ),
);

const ContractEntryTB = Type.Readonly(Type.Union([RegularContractEntryTB, ProxyContractEntryTB]));

export const ExplorerSectionTB = Type.Readonly(
  Type.Object(
    {
      rpcUrl: Type.String(),
      explorerHostname: Type.Optional(Type.String()),
      explorerTokenEnv: Type.Optional(Type.String()),
      chainId: Type.Optional(Type.Union([Type.Number(), Type.String()])),
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
      l1: EthereumStringArrayTB,
      l2: Type.Optional(EthereumStringArrayTB),
    },
    { additionalProperties: false },
  ),
);

export const EntireDocumentTB = Type.Readonly(
  Type.Object(
    {
      parameters: Type.Optional(PlainValueOrArray),
      roles: Type.Optional(Type.Union([EthereumStringArrayTB, Type.Null()])),
      misc: Type.Optional(PlainValueOrArray),
      eoa: Type.Optional(EthereumStringArrayTB),
      deployed: DeployedSectionTB,
      "deployed-aux": Type.Optional(EthereumStringArrayTB),
      l1: NetworkSectionTB,
      l2: Type.Optional(NetworkSectionTB),
      tvl: Type.Optional(PlainValueOrArray),
      delays: Type.Optional(PlainValueOrArray),
      signers: Type.Optional(PlainValueOrArray),
      selectors: Type.Optional(PlainValueOrArray),
      validators: Type.Optional(PlainValueOrArray),
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
      eoa: Type.Optional(EthereumStringArrayTB),
      roles: Type.Optional(Type.Union([EthereumStringArrayTB, Type.Null()])),
      misc: Type.Optional(PlainValueOrArray),
    },
    { additionalProperties: false },
  ),
);
