import type { Metadata } from 'next';
import './globals.css';
import Providers from '@/components/Providers';
import Header from '@/components/Header';

export const metadata: Metadata = {
  title: 'AtomicSwap — Smart Swap Aggregator on Stellar',
  description:
    'Peer-to-peer atomic swaps with smart DEX routing. The cheapest way to swap on Stellar.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Providers>
          <Header />
          <main style={{ position: 'relative', zIndex: 1 }}>{children}</main>
        </Providers>
      </body>
    </html>
  );
}
