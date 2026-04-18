'use client';

import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';

interface WalletState {
  connected: boolean;
  address: string | null;
  network: string | null;
  loading: boolean;
}

interface WalletContextType extends WalletState {
  connect: () => Promise<void>;
  disconnect: () => void;
  signTransaction: (xdr: string) => Promise<string>;
}

const WalletContext = createContext<WalletContextType | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WalletState>({
    connected: false,
    address: null,
    network: null,
    loading: false,
  });

  // On mount, check if we're already connected (user previously granted access)
  useEffect(() => {
    (async () => {
      if (typeof window === 'undefined') return;
      try {
        const freighter = await import('@stellar/freighter-api');
        const connected = await freighter.isConnected();
        if (!connected) return;

        const allowed = await freighter.isAllowed();
        if (!allowed) return;

        // Already authorized — restore session
        const address = await freighter.getPublicKey();
        const networkDetails = await freighter.getNetworkDetails();

        if (address) {
          setState({
            connected: true,
            address,
            network: networkDetails.network || 'TESTNET',
            loading: false,
          });
        }
      } catch {
        // Extension not installed or errored — that's fine
      }
    })();
  }, []);

  const connect = useCallback(async () => {
    if (typeof window === 'undefined') return;

    setState((s) => ({ ...s, loading: true }));
    try {
      const freighter = await import('@stellar/freighter-api');

      // Check if extension is installed
      const installed = await freighter.isConnected();
      if (!installed) {
        // Extension not found — open download page
        window.open('https://www.freighter.app/', '_blank');
        setState((s) => ({ ...s, loading: false }));
        return;
      }

      // Request access — this pops up the Freighter approval dialog
      const accessResult = await freighter.requestAccess();

      // After approval, get the public key and network
      const address = typeof accessResult === 'string'
        ? accessResult
        : await freighter.getPublicKey();

      const networkDetails = await freighter.getNetworkDetails();

      if (address) {
        setState({
          connected: true,
          address,
          network: networkDetails.network || 'TESTNET',
          loading: false,
        });
      } else {
        setState((s) => ({ ...s, loading: false }));
      }
    } catch (error) {
      console.error('Wallet connection failed:', error);
      setState((s) => ({ ...s, loading: false }));
    }
  }, []);

  const disconnect = useCallback(() => {
    setState({ connected: false, address: null, network: null, loading: false });
  }, []);

  const signTransaction = useCallback(
    async (xdr: string): Promise<string> => {
      if (!state.connected) {
        throw new Error('Wallet not connected');
      }

      const freighter = await import('@stellar/freighter-api');
      const networkDetails = await freighter.getNetworkDetails();

      const signed = await freighter.signTransaction(xdr, {
        network: networkDetails.network || 'TESTNET',
        networkPassphrase: networkDetails.networkPassphrase || 'Test SDF Network ; September 2015',
      });

      return signed;
    },
    [state.connected]
  );

  return (
    <WalletContext.Provider
      value={{
        ...state,
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
