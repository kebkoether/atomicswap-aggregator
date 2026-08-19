'use client';

import { useEffect, useRef, useState } from 'react';
import { useWallet } from '@/context/WalletContext';

const IS_MAINNET = (process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? '').startsWith('Public Global');

export default function Header() {
  const { connected, address, loading, connect, disconnect } = useWallet();
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const copyAddress = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

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
              color: IS_MAINNET ? '#22c55e' : '#f59e0b',
              background: IS_MAINNET ? 'rgba(34, 197, 94, 0.1)' : 'rgba(245, 158, 11, 0.12)',
              padding: '2px 8px',
              borderRadius: '4px',
              letterSpacing: '0.5px',
            }}
          >
            {IS_MAINNET ? 'MAINNET' : 'TESTNET'}
          </span>
        </div>

        {/* Nav Links */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '32px' }}>
          <a
            href="/"
            style={{ fontSize: '14px', fontWeight: 500, color: '#e1e4ea', textDecoration: 'none' }}
          >
            Swap
          </a>
          <a
            href="/orders"
            style={{ fontSize: '14px', fontWeight: 500, color: '#8a8f9c', textDecoration: 'none' }}
          >
            Orders
          </a>

          {connected && address ? (
            <div ref={menuRef} style={{ position: 'relative' }}>
              <button
                onClick={() => setMenuOpen((v) => !v)}
                style={{
                  background: '#1a1f2e',
                  color: '#e1e4ea',
                  border: menuOpen ? '1px solid #6366f1' : '1px solid #252a3a',
                  borderRadius: '10px',
                  padding: '10px 16px',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#22c55e' }} />
                {address.slice(0, 4)}...{address.slice(-4)}
                <span style={{ fontSize: '10px', opacity: 0.6 }}>▾</span>
              </button>

              {menuOpen && (
                <div
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 6px)',
                    right: 0,
                    background: '#131722',
                    border: '1px solid #252a3a',
                    borderRadius: '12px',
                    padding: '6px',
                    minWidth: '200px',
                    boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
                  }}
                >
                  <div
                    style={{
                      padding: '8px 10px',
                      fontSize: '11px',
                      color: '#565b68',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      wordBreak: 'break-all',
                    }}
                  >
                    {address.slice(0, 10)}…{address.slice(-8)}
                  </div>
                  <button onClick={copyAddress} style={menuItemStyle}>
                    {copied ? '✓ Copied' : 'Copy address'}
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      // Freighter reconnects silently while authorized — to
                      // switch accounts, change the active account in the
                      // Freighter extension, then reconnect.
                      disconnect();
                      setTimeout(() => connect(), 100);
                    }}
                    style={menuItemStyle}
                  >
                    Reconnect / switch account
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      disconnect();
                    }}
                    style={{ ...menuItemStyle, color: '#ef4444' }}
                  >
                    Disconnect
                  </button>
                </div>
              )}
            </div>
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

const menuItemStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '9px 10px',
  background: 'transparent',
  border: 'none',
  borderRadius: '8px',
  color: '#e1e4ea',
  fontSize: '13px',
  cursor: 'pointer',
};
