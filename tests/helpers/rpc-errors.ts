import { type JsonRpcPayload, JsonRpcProvider } from "ethers";

const PAYLOAD: JsonRpcPayload = {
  id: 1,
  jsonrpc: "2.0",
  method: "eth_call",
  params: [{ data: "0x", to: "0x0000000000000000000000000000000000000001" }, "latest"],
};

/** The error ethers raises for an eth_call that the node answered with this JSON-RPC error. */
export function callError(error: { code: number; data?: string; message: string }): Error {
  const provider = new JsonRpcProvider("http://localhost:0", undefined, { staticNetwork: true });
  try {
    return provider.getRpcError(PAYLOAD, { error, id: 1 });
  } finally {
    provider.destroy();
  }
}

export const REVERT = { code: -32000, message: "execution reverted" };
export const NO_STATE = { code: -32000, message: `historical state 0x${"ab".repeat(32)} is not available` };
