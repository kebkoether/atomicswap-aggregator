'use client';

import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';

/**
 * Freighter wallet context — written against @stellar/freighter-api v2+.
 * v2 breaking changes vs v1:
 *   - every call returns an object ({ address }, { isConnected }, ...)
 *   - getPublicKey() is gone → requestAccess() / getAddress()
 *   - signTransaction() returns { signedTxXdr, signerAddress }
 */

/** The network this app is built against. Signing on any other network is refused. */
const EXPECTED_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015';

interface WalletState {
  connected: boolean;
  address: string | null;
  network: string | null;
  networkPassphrase: string | null;
  /** True when the wallet is on a different network than the app expects. */
  networkMismatch: boolean;
  loading: boolean;
}

interface WalletContextType extends WalletState {
  expectedNetworkPassphrase: string;
  connect: () => Promise<void>;
  disconnect: () => void;
  signTransaction: (xdr: string) => Promise<string>;
}

const WalletContext = createContext<WalletContextType | null>(null);

const DISCONNECTED: WalletState = {
  connected: false,
  address: null,
  network: null,
  networkPassphrase: null,
  networkMismatch: false,
  loading: false,
};

export function WalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WalletState>(DISCONNECTED);

  const applyConnection = useCallback(
    (address: string, network: string | null, networkPassphrase: string | null) => {
      setState({
        connected: true,
        address,
        network,
        networkPassphrase,
        networkMismatch:
          networkPassphrase !== null && networkPassphrase !== EXPECTED_PASSPHRASE,
        loading: false,
      });
    },
    []
  );

  // On mount, restore a previously-granted session
  useEffect(() => {
    (async () => {
      if (typeof window === 'undefined') return;
      try {
        const freighter = await import('@stellar/freighter-api');

        const connected = await freighter.isConnected();
        if (!connected.isConnected) return;

        const allowed = await freighter.isAllowed();
        if (!allowed.isAllowed) return;

        const addr = await freighter.getAddress();
        if (!addr.address) return;

        const details = await freighter.getNetworkDetails();
        applyConnection(
          addr.address,
          details.network ?? null,
          details.networkPassphrase ?? null
        );
      } catch {
        // Extension not installed or errored — that's fine
      }
    })();
  }, [applyConnection]);

  const connect = useCallback(async () => {
    if (typeof window === 'undefined') return;

    setState((s) => ({ ...s, loading: true }));
    try {
      const freighter = await import('@stellar/freighter-api');

      const connected = await freighter.isConnected();
      if (!connected.isConnected) {
        // Extension not found — open download page
        window.open('https://www.freighter.app/', '_blank');
        setState((s) => ({ ...s, loading: false }));
        return;
      }

      // Pops the Freighter approval dialog
      const access = await freighter.requestAccess();
      if (access.error || !access.address) {
        console.error('Freighter access denied:', access.error);
        setState((s) => ({ ...s, loading: false }));
        return;
      }

      const details = await freighter.getNetworkDetails();
      applyConnection(
        access.address,
        details.network ?? null,
        details.networkPassphrase ?? null
      );
    } catch (error) {
      console.error('Wallet connection failed:', error);
      setState((s) => ({ ...s, loading: false }));
    }
  }, [applyConnection]);

  const disconnect = useCallback(() => {
    setState(DISCONNECTED);
  }, []);

  const signTransaction = useCallback(
    async (xdr: string): Promise<string> => {
      if (!state.connected || !state.address) {
        throw new Error('Wallet not connected');
      }

      const freighter = await import('@stellar/freighter-api');

      // Re-check the network at signing time — the user may have switched
      const details = await freighter.getNetworkDetails();
      if (details.networkPassphrase !== EXPECTED_PASSPHRASE) {
        throw new Error(
          `Wrong network: wallet is on "${details.network ?? 'unknown'}" but this app targets ` +
          `"${EXPECTED_PASSPHRASE}". Switch networks in Freighter and try again.`
        );
      }

      const result = await freighter.signTransaction(xdr, {
        networkPassphrase: EXPECTED_PASSPHRASE,
        address: state.address,
      });
      if (result.error || !result.signedTxXdr) {
        throw new Error(
          `Signing failed: ${typeof result.error === 'string' ? result.error : 'rejected in Freighter'}`
        );
      }
      return result.signedTxXdr;
    },
    [state.connected, state.address]
  );

  return (
    <WalletContext.Provider
      value={{
        ...state,
        expectedNetworkPassphrase: EXPECTED_PASSPHRASE,
        connect,
        disconnect,
        signTransaction,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletContextType {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return ctx;
}
