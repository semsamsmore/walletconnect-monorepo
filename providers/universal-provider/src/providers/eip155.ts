import Client from "@walletconnect/sign-client";
import { JsonRpcProvider } from "@walletconnect/jsonrpc-provider";
import { HttpConnection } from "@walletconnect/jsonrpc-http-connection";
import { EngineTypes, SessionTypes } from "@walletconnect/types";

import {
  IProvider,
  RpcProvidersMap,
  SubProviderOpts,
  RequestParams,
  SessionNamespace,
} from "../types";

import { getChainId, getGlobal, getRpcUrl } from "../utils";
import EventEmitter from "events";
import { BUNDLER_URL, PROVIDER_EVENTS } from "../constants";
import { formatJsonRpcRequest } from "@walletconnect/jsonrpc-utils";

class Eip155Provider implements IProvider {
  public name = "eip155";
  public client: Client;
  // the active chainId on the dapp
  public chainId: number;
  public namespace: SessionNamespace;
  public httpProviders: RpcProvidersMap;
  public events: EventEmitter;

  constructor(opts: SubProviderOpts) {
    this.namespace = opts.namespace;
    this.events = getGlobal("events");
    this.client = getGlobal("client");
    this.httpProviders = this.createHttpProviders();
    this.chainId = parseInt(this.getDefaultChain());
  }

  public async request<T = unknown>(args: RequestParams): Promise<T> {
    switch (args.request.method) {
      case "eth_requestAccounts":
        return this.getAccounts() as unknown as T;
      case "eth_accounts":
        return this.getAccounts() as unknown as T;
      case "wallet_switchEthereumChain": {
        return (await this.handleSwitchChain(args)) as unknown as T;
      }
      case "eth_chainId":
        return parseInt(this.getDefaultChain()) as unknown as T;
      case "wallet_getCapabilities":
        return (await this.getCapabilities(args)) as unknown as T;
      case "wallet_getCallsStatus":
        return (await this.getCallStatus(args)) as unknown as T;
      default:
        break;
    }
    if (this.namespace.methods.includes(args.request.method)) {
      return await this.client.request(args as EngineTypes.RequestParams);
    }
    // FIX: was missing await and was not returning the awaited promise causing any requests after chainSwitch to hang / auto reject
    return await this.getHttpProvider().request(args.request);
  }

  public updateNamespace(namespace: SessionTypes.Namespace) {
    this.namespace = Object.assign(this.namespace, namespace);
  }

  public setDefaultChain(chainId: string, rpcUrl?: string | undefined) {
    // http provider exists so just set the chainId
    if (!this.httpProviders[chainId]) {
      this.setHttpProvider(parseInt(chainId), rpcUrl);
    }
    this.chainId = parseInt(chainId);
    this.events.emit(PROVIDER_EVENTS.DEFAULT_CHAIN_CHANGED, `${this.name}:${chainId}`);
  }

  public requestAccounts(): string[] {
    return this.getAccounts();
  }

  public getDefaultChain(): string {
    if (this.chainId) return this.chainId.toString();
    if (this.namespace.defaultChain) return this.namespace.defaultChain;

    const chainId = this.namespace.chains[0];
    if (!chainId) throw new Error(`ChainId not found`);

    return chainId.split(":")[1];
  }

  // ---------- Private ----------------------------------------------- //

  private createHttpProvider(
    chainId: number,
    rpcUrl?: string | undefined,
  ): JsonRpcProvider | undefined {
    const rpc =
      rpcUrl || getRpcUrl(`${this.name}:${chainId}`, this.namespace, this.client.core.projectId);
    if (!rpc) {
      throw new Error(`No RPC url provided for chainId: ${chainId}`);
    }
    const http = new JsonRpcProvider(new HttpConnection(rpc, getGlobal("disableProviderPing")));
    return http;
  }

  private setHttpProvider(chainId: number, rpcUrl?: string): void {
    const http = this.createHttpProvider(chainId, rpcUrl);
    if (http) {
      this.httpProviders[chainId] = http;
    }
  }

  private createHttpProviders(): RpcProvidersMap {
    const http = {};
    this.namespace.chains.forEach((chain) => {
      const parsedChain = parseInt(getChainId(chain));
      http[parsedChain] = this.createHttpProvider(parsedChain, this.namespace.rpcMap?.[chain]);
    });
    return http;
  }

  private getAccounts(): string[] {
    const accounts = this.namespace.accounts;
    if (!accounts) {
      return [];
    }
    return [
      ...new Set(
        accounts
          // get the accounts from the active chain
          .filter((account) => account.split(":")[1] === this.chainId.toString())
          // remove namespace & chainId from the string
          .map((account) => account.split(":")[2]),
      ),
    ];
  }

  private getHttpProvider(): JsonRpcProvider {
    const chain = this.chainId;
    const http = this.httpProviders[chain];
    if (typeof http === "undefined") {
      throw new Error(`JSON-RPC provider for ${chain} not found`);
    }
    return http;
  }

  private async handleSwitchChain(args: RequestParams): Promise<any> {
    let hexChainId = args.request.params ? args.request.params[0]?.chainId : "0x0";
    hexChainId = hexChainId.startsWith("0x") ? hexChainId : `0x${hexChainId}`;
    const parsedChainId = parseInt(hexChainId, 16);
    // if chainId is already approved, switch locally
    if (this.isChainApproved(parsedChainId)) {
      this.setDefaultChain(`${parsedChainId}`);
    } else if (this.namespace.methods.includes("wallet_switchEthereumChain")) {
      // try to switch chain within the wallet
      await this.client.request({
        topic: args.topic,
        request: {
          method: args.request.method,
          params: [
            {
              chainId: hexChainId,
            },
          ],
        },
        chainId: this.namespace.chains?.[0], // Sending a previously unapproved chainId will cause namespace validation failure so we must set request chainId to the first chainId in the namespace to avoid it
      } as EngineTypes.RequestParams);
      this.setDefaultChain(`${parsedChainId}`);
    } else {
      throw new Error(
        `Failed to switch to chain 'eip155:${parsedChainId}'. The chain is not approved or the wallet does not support 'wallet_switchEthereumChain' method.`,
      );
    }
    return null;
  }

  private isChainApproved(chainId: number): boolean {
    return this.namespace.chains.includes(`${this.name}:${chainId}`);
  }

  private async getCapabilities(args: RequestParams) {
    // if capabilities are stored in the session, return them, else send the request to the wallet
    const address = args.request?.params?.[0];
    if (!address) throw new Error("Missing address parameter in `wallet_getCapabilities` request");
    const session = this.client.session.get(args.topic);
    const sessionCapabilities = session?.sessionProperties?.capabilities || {};
    if (sessionCapabilities?.[address]) {
      return sessionCapabilities?.[address];
    }
    // intentionally omit catching errors/rejection during `request` to allow the error to bubble up
    const capabilities = await this.client.request(args as EngineTypes.RequestParams);
    try {
      // update the session with the capabilities so they can be retrieved later
      await this.client.session.update(args.topic, {
        sessionProperties: {
          ...(session.sessionProperties || {}),
          capabilities: {
            ...(sessionCapabilities || {}),
            [address]: capabilities,
          } as any, // by spec sessionProperties should be <string, string> but here are used as objects?
        },
      });
    } catch (error) {
      console.warn("Failed to update session with capabilities", error);
    }
    return capabilities;
  }

  private async getCallStatus(args: RequestParams) {
    const session = this.client.session.get(args.topic);
    const bundlerName = session.sessionProperties?.bundler_name;
    if (bundlerName) {
      const bundlerUrl = this.getBundlerUrl(args.chainId, bundlerName);
      try {
        return await this.getUserOperationReceipt(bundlerUrl, args);
      } catch (error) {
        console.warn("Failed to fetch call status from bundler", error, bundlerUrl);
      }
    }
    const customUrl = session.sessionProperties?.bundler_url;
    if (customUrl) {
      try {
        return await this.getUserOperationReceipt(customUrl, args);
      } catch (error) {
        console.warn("Failed to fetch call status from custom bundler", error, customUrl);
      }
    }

    if (this.namespace.methods.includes(args.request.method)) {
      return await this.client.request(args as EngineTypes.RequestParams);
    }

    throw new Error("Fetching call status not approved by the wallet.");
  }

  private async getUserOperationReceipt(bundlerUrl: string, args: RequestParams) {
    const url = new URL(bundlerUrl);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        formatJsonRpcRequest("eth_getUserOperationReceipt", [args.request.params?.[0]]),
      ),
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch user operation receipt - ${response.status}`);
    }
    return await response.json();
  }

  private getBundlerUrl(cap2ChainId: string, bundlerName: string) {
    return `${BUNDLER_URL}?projectId=${this.client.core.projectId}&chainId=${cap2ChainId}&bundler=${bundlerName}`;
  }
}

export default Eip155Provider;
