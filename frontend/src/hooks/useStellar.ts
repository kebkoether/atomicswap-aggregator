/**
 * React hook for Stellar wallet integration.
 *
 * Supports Freighter wallet (the most common Stellar wallet).
 * Handles connection, signing, and transaction submission.
 */

'use client';

import { useState, useCallback, useEffect } from 'react';

interface WalletState {
  connected: boolean;
  address: string | null;
  network: string | null;
}

export function useStellar() {
  const [wallet, setWallet] = useState<WalletState>({
    connected: false,
    address: null,
    network: null,
  });
  const [loading, setLoading] = useState(false);

  // Check if Freighter is installed
  const isFreighterInstalled = useCallback((): boolean => {
    return typeof window !== 'undefined' && !!(window as any).freighter;
  }, []);

  // Connect to Freighter
  const connect = useCallback(async () => {
    if (!isFreighterInstalled()) {
      window.open('https://www.freighter.app/', '_blank');
      return;
    }

    setLoading(true);
    try {
      const freighter = await import('@stellar/freighter-api');

      // Request access
      const address = await freighter.requestAccess();
      const network = await freighter.getNetwork();

      setWallet({
        connected: true,
        address,
        network,
      });
    } catch (error) {
      console.error('Wallet connection failed:', error);
    } finally {
      setLoading(false);
    }
  }, [isFreighterInstalled]);

  // Sign and submit a transaction
  const signTransaction = useCallback(
    async (xdr: string): Promise<string> => {
      if (!wallet.connected) {
        throw new Error('Wallet not connected');
      }

      const freighter = await import('@stellar/freighter-api');
      const signed = await freighter.signTransaction(xdr, {
        network: wallet.network ?? 'PUBLIC',
        networkPassphrase:
          'Public Global Stellar Network ; September 2015',
      });

      return signed;
    },
    [wallet]
  );

  // Disconnect
  const disconnect = useCallback(() => {
    setWallet({ connected: false, address: null, network: null });
  }, []);

  return {
    wallet,
    loading,
    connect,
    disconnect,
    signTransaction,
    isFreighterInstalled: isFreighterInstalled(),
  };
}
