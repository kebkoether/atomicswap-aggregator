'use client';

import { useWallet } from '@/context/WalletContext';

export default function Header() {
  const { connected, address, loading, connect, disconnect } = useWallet();

  return (
    <header
      style={{
        position: 'relative',
        zIndex: 10,
        borderBottom: '1px solid #1a1f2e',
        backdropFilter: 'blur(12px)',
        background: 'rgba(11, 14, 17, 0.8)',
      }}
    >
      <nav
        style={{
          maxWidth: '1200px',
          margin: '0 auto',
          padding: '0 24px',
          height: '64px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '10px',
              background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '18px',
              fontWeight: 700,
              color: 'white',
              letterSpacing: '-1px',
            }}
          >
            A
          </div>
          <span
            style={{
              fontSize: '18px',
              fontWeight: 700,
              color: '#e1e4ea',
              letterSpacing: '-0.3px',
            }}
          >
            AtomicSwap
          </span>
          <span
            style={{
              fontSize: '11px',
              fontWeight: 500,
              color: '#6366f1',
              background: 'rgba(99, 102, 241, 0.1)',
              padding: '2px 8px',
              borderRadius: '4px',
              letterSpacing: '0.5px',
            }}
          >
            TESTNET
          </span>
        </div>

        {/* Nav Links */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '32px' }}>
          <a
            href="/"
            style={{
              fontSize: '14px',
              fontWeight: 500,
              color: '#e1e4ea',
              textDecoration: 'none',
            }}
          >
            Swap
          </a>
          <a
            href="/orders"
            style={{
              fontSize: '14px',
              fontWeight: 500,
              color: '#8a8f9c',
              textDecoration: 'none',
            }}
          >
            Orders
          </a>

          {connected && address ? (
            <button
              onClick={disconnect}
              style={{
                background: '#1a1f2e',
                color: '#e1e4ea',
                border: '1px solid #252a3a',
                borderRadius: '10px',
                padding: '10px 16px',
                fontSize: '14px',
                fontWeight: 500,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = '#ef4444';
                e.currentTarget.style.color = '#ef4444';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = '#252a3a';
                e.currentTarget.style.color = '#e1e4ea';
              }}
            >
              <div
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  background: '#22c55e',
                }}
              />
              {address.slice(0, 4)}...{address.slice(-4)}
            </button>
          ) : (
            <button
              onClick={connect}
              disabled={loading}
              style={{
                background: 'linear-gradient(135deg, #6366f1, #7c3aed)',
                color: 'white',
                border: 'none',
                borderRadius: '10px',
                padding: '10px 20px',
                fontSize: '14px',
                fontWeight: 600,
                cursor: loading ? 'wait' : 'pointer',
                letterSpacing: '-0.2px',
                opacity: loading ? 0.7 : 1,
              }}
            >
              {loading ? 'Connecting...' : 'Connect Wallet'}
            </button>
          )}
        </div>
      </nav>
    </header>
  );
}
