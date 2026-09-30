# Environment Reference

[Back to README](../README.md)

Variables come from the shell and from a `.env` file in the working directory. `.env.sample` holds public RPC defaults: copy it to `.env` and adjust. Configuration CI jobs use repository secrets for API keys and RPC URLs, with public RPC fallbacks. The CI User-Agent override comes from the `STATE_MATE_USER_AGENT` repository variable.

| Variable                | Purpose                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<NETWORK>_RPC_URL`     | RPC endpoint for one network. Each config section names its variable in `rpcUrl`; `.env.sample` lists every name the bundled configs use                     |
| `ETHERSCAN_TOKEN`       | Etherscan API key. Used by ABI downloads when named in `explorerTokenEnv`; also the fallback for Etherscan ACL scans                                         |
| `BLOCKSCOUT_TOKEN`      | Optional fallback key for Blockscout ACL scans when the section does not configure a key for that same explorer                                              |
| `<EXPLORER_KEY>`        | Custom API-key variable named by `explorerTokenEnv`. ABI downloads use it; ACL scans reuse it only for the matching explorer                                 |
| `STATE_MATE_USER_AGENT` | Replaces the `User-Agent` sent with every outgoing request, explorer and RPC alike. The default is browser-like with a trailing `state-mate/<version>` token |

Explorer requests also send a same-origin Referer without API keys. For the credential selection rules, see [Configure credentials for ACL scans](how-to.md#configure-credentials-for-acl-scans).
