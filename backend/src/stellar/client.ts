/**
 * Soroban RPC client — handles all on-chain interactions.
 *
 * Uses @stellar/stellar-sdk to:
 * - Simulate contract calls (for quotes, no gas cost)
 * - Build and submit real transactions (for swaps)
 * - Query contract state
 */

import {
  Contract,
  TransactionBuilder,
  Keypair,
  Account,
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
  rpc,
} from '@stellar/stellar-sdk';

export interface StellarClientConfig {
  rpcUrl: string;
  networkPassphrase: string;
  adminKeypair?: InstanceType<typeof Keypair>;
}

export class StellarClient {
  private server: rpc.Server;
  private networkPassphrase: string;
  private adminKeypair?: InstanceType<typeof Keypair>;

  constructor(config: StellarClientConfig) {
    this.server = new rpc.Server(config.rpcUrl);
    this.networkPassphrase = config.networkPassphrase;
    this.adminKeypair = config.adminKeypair;
  }

  /**
   * Simulate a contract call without submitting a transaction.
   * Used for getting quotes and reading state — no gas cost.
   */
  async simulateCall(
    contractId: string,
    method: string,
    args: xdr.ScVal[]
  ): Promise<xdr.ScVal | null> {
    try {
      const contract = new Contract(contractId);
      const operation = contract.call(method, ...args);

      // Build a throwaway transaction just for simulation
      const account = await this.getTransientAccount();
      const tx = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const simResult = await this.server.simulateTransaction(tx);

      if (rpc.Api.isSimulationSuccess(simResult)) {
        const resultVal = simResult.result?.retval;
        return resultVal ?? null;
      }

      console.warn(`Simulation failed for ${contractId}.${method}`);
      return null;
    } catch (error) {
      console.error(`simulateCall error (${contractId}.${method}):`, error);
      return null;
    }
  }

  /**
   * Simulate and return a native JS value from a contract call.
   */
  async simulateAndParse<T>(
    contractId: string,
    method: string,
    args: xdr.ScVal[]
  ): Promise<T | null> {
    const result = await this.simulateCall(contractId, method, args);
    if (!result) return null;
    try {
      return scValToNative(result) as T;
    } catch {
      return null;
    }
  }

  /**
   * Build a transaction for a contract call (unsigned).
   * The frontend signs this with the user's wallet.
   */
  async buildTransaction(
    sourceAddress: string,
    contractId: string,
    method: string,
    args: xdr.ScVal[]
  ): Promise<string> {
    const contract = new Contract(contractId);
    const operation = contract.call(method, ...args);

    const account = await this.server.getAccount(sourceAddress);
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(300)
      .build();

    const simResult = await this.server.simulateTransaction(tx);

    if (!rpc.Api.isSimulationSuccess(simResult)) {
      throw new Error(`Transaction simulation failed`);
    }

    const preparedTx = rpc.assembleTransaction(tx, simResult);
    return preparedTx.build().toXDR();
  }

  /**
   * Submit a signed transaction XDR.
   */
  async submitTransaction(signedXdr: string): Promise<rpc.Api.GetTransactionResponse> {
    const tx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    const response = await this.server.sendTransaction(tx);

    if (response.status === 'ERROR') {
      throw new Error(`Transaction send failed: ${JSON.stringify(response)}`);
    }

    // Poll for result
    let getResponse = await this.server.getTransaction(response.hash);
    while (getResponse.status === 'NOT_FOUND') {
      await new Promise((r) => setTimeout(r, 1000));
      getResponse = await this.server.getTransaction(response.hash);
    }

    return getResponse;
  }

  // ─── Helper: ScVal builders ───────────────────────────

  static toAddress(address: string): xdr.ScVal {
    return new Address(address).toScVal();
  }

  static toI128(value: bigint): xdr.ScVal {
    return nativeToScVal(value, { type: 'i128' });
  }

  static toU32(value: number): xdr.ScVal {
    return nativeToScVal(value, { type: 'u32' });
  }

  static toU64(value: number): xdr.ScVal {
    return nativeToScVal(value, { type: 'u64' });
  }

  // ─── Internal ─────────────────────────────────────────

  private async getTransientAccount(): Promise<Account> {
    if (this.adminKeypair) {
      try {
        return await this.server.getAccount(this.adminKeypair.publicKey());
      } catch {
        // fallthrough
      }
    }

    // Use a random keypair for simulation
    const randomKp = Keypair.random();
    return new Account(randomKp.publicKey(), '0');
  }
}
