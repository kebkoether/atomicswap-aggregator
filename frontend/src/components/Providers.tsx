'use client';

import { ReactNode } from 'react';
import { WalletProvider } from '@/context/WalletContext';

export default function Providers({ children }: { children: ReactNode }) {
  return <WalletProvider>{children}</WalletProvider>;
}
