# Environment Reference

[Back to README](../README.md)

Variables come from the shell and from a `.env` file in the working directory. `.env.sample` holds free public defaults: copy it to `.env` and adjust. CI sets the same variables from repository secrets, falling back to the `.env.sample` defaults.

| Variable                | Purpose                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<NETWORK>_RPC_URL`     | RPC endpoint for one network. Each config section names its variable in `rpcUrl`; `.env.sample` lists every name the bundled configs use                     |
| `ETHERSCAN_TOKEN`       | Etherscan API key. Configs name it in `explorerTokenEnv` for ABI downloads; the exhaustive ACL scan requires it on etherscan-served chains                   |
| `STATE_MATE_USER_AGENT` | Replaces the `User-Agent` sent with every outgoing request, explorer and RPC alike. The default is browser-like with a trailing `state-mate/<version>` token |
