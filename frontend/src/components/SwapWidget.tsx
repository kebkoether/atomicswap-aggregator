'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useWallet } from '@/context/WalletContext';
import { getQuote as fetchQuote, buildPeerSwap } from '@/lib/api';

// ─── Token Data ─────────────────────────────────────────

interface Token {
  symbol: string;
  name: string;
  color: string;
  letterBg: string;
  status: 'live' | 'coming_soon';
}

const TOKENS: Token[] = [
  { symbol: 'USDC', name: 'USD Coin', color: '#2775ca', letterBg: '#2775ca', status: 'live' },
  { symbol: 'PYUSD', name: 'PayPal USD', color: '#0070e0', letterBg: '#003087', status: 'live' },
  { symbol: 'USDY', name: 'Ondo USDY', color: '#5865f2', letterBg: '#1a1a6e', status: 'live' },
  { symbol: 'USDT0', name: 'Tether', color: '#26a17b', letterBg: '#26a17b', status: 'coming_soon' },
  { symbol: 'SolvBTC', name: 'Solv BTC', color: '#f7931a', letterBg: '#f7931a', status: 'live' },
];

const LIVE_TOKENS = TOKENS.filter((t) => t.status === 'live');

// ─── Token Icon ─────────────────────────────────────────

function TokenIcon({ symbol, color, size = 28 }: { symbol: string; color: string; size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: `linear-gradient(145deg, ${color}, ${color}aa)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.36,
        fontWeight: 700,
        color: 'white',
        flexShrink: 0,
        boxShadow: `0 2px 8px ${color}33`,
      }}
    >
      {symbol === 'USDC' ? '$' : symbol === 'PYUSD' ? 'P' : symbol === 'USDY' ? 'Y' : symbol.charAt(0)}
    </div>
  );
}

// ─── Token Dropdown ─────────────────────────────────────

function TokenDropdown({
  selected,
  tokens,
  onSelect,
  exclude,
}: {
  selected: string;
  tokens: Token[];
  onSelect: (symbol: string) => void;
  exclude?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selectedToken = tokens.find((t) => t.symbol === selected) || tokens[0];
  // Show all tokens but exclude the one selected on the other side
  const available = tokens.filter((t) => t.symbol !== exclude);

  return (
    <div ref={ref} style={{ position: 'relative', zIndex: open ? 50 : 1 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          background: '#1e2433',
          border: open ? '1px solid #6366f1' : '1px solid #2a3040',
          borderRadius: '12px',
          padding: '8px 12px 8px 8px',
          cursor: 'pointer',
          color: '#e1e4ea',
          fontSize: '15px',
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        <TokenIcon symbol={selectedToken.symbol} color={selectedToken.color} size={26} />
        {selectedToken.symbol}
        <svg width="10" height="10" viewBox="0 0 10 10" style={{ marginLeft: '2px', opacity: 0.5, transform: open ? 'rotate(180deg)' : '', transition: 'transform 0.15s' }}>
          <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            background: '#1a1f2e',
            border: '1px solid #252a3a',
            borderRadius: '14px',
            padding: '4px',
            minWidth: '220px',
            maxHeight: '320px',
            overflowY: 'auto',
            boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          }}
        >
          <div style={{ padding: '8px 12px 6px', fontSize: '11px', color: '#565b68', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Select token
          </div>
          {available.map((token) => {
            const isComingSoon = token.status === 'coming_soon';
            return (
              <button
                key={token.symbol}
                onClick={() => { if (!isComingSoon) { onSelect(token.symbol); setOpen(false); } }}
                disabled={isComingSoon}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  width: '100%',
                  padding: '10px 12px',
                  background: token.symbol === selected ? 'rgba(99, 102, 241, 0.1)' : 'transparent',
                  border: 'none',
                  borderRadius: '10px',
                  cursor: isComingSoon ? 'default' : 'pointer',
                  color: isComingSoon ? '#3a3f4c' : '#e1e4ea',
                  fontSize: '14px',
                  opacity: isComingSoon ? 0.5 : 1,
                }}
                onMouseEnter={(e) => { if (!isComingSoon) e.currentTarget.style.background = 'rgba(99,102,241,0.08)'; }}
                onMouseLeave={(e) => { if (!isComingSoon) e.currentTarget.style.background = token.symbol === selected ? 'rgba(99,102,241,0.1)' : 'transparent'; }}
              >
                <TokenIcon symbol={token.symbol} color={token.color} size={32} />
                <div style={{ textAlign: 'left', flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: '14px' }}>{token.symbol}</div>
                  <div style={{ fontSize: '12px', color: isComingSoon ? '#3a3f4c' : '#8a8f9c' }}>{token.name}</div>
                </div>
                {isComingSoon && (
                  <span style={{
                    fontSize: '10px',
                    fontWeight: 600,
                    color: '#565b68',
                    background: 'rgba(86, 91, 104, 0.15)',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    whiteSpace: 'nowrap',
                  }}>
                    SOON
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Input Panel ────────────────────────────────────────

function InputPanel({
  label,
  sublabel,
  value,
  onChange,
  readOnly,
  token,
  tokens,
  onTokenSelect,
  excludeToken,
  accent,
}: {
  label: string;
  sublabel?: string;
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  token: string;
  tokens: Token[];
  onTokenSelect: (s: string) => void;
  excludeToken?: string;
  accent?: string;
}) {
  return (
    <div
      style={{
        background: '#0d1117',
        borderRadius: '16px',
        padding: '16px 18px',
        border: '1px solid #161b26',
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {accent && (
            <div style={{ width: '3px', height: '14px', borderRadius: '2px', background: accent }} />
          )}
          <span style={{ fontSize: '13px', fontWeight: 600, color: '#8a8f9c' }}>
            {label}
          </span>
        </div>
        {sublabel && (
          <span style={{ fontSize: '12px', color: '#565b68' }}>{sublabel}</span>
        )}
      </div>

      {/* Amount + Token row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {readOnly ? (
          <span
            style={{
              flex: 1,
              fontSize: '28px',
              fontWeight: 600,
              color: value && value !== '0.00' ? '#e1e4ea' : '#3a3f4c',
              letterSpacing: '-0.5px',
            }}
          >
            {value || '0.00'}
          </span>
        ) : (
          <input
            type="number"
            value={value}
            onChange={(e) => onChange?.(e.target.value)}
            placeholder="0.00"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              fontSize: '28px',
              fontWeight: 600,
              color: '#e1e4ea',
              letterSpacing: '-0.5px',
              width: '100%',
              minWidth: 0,
            }}
          />
        )}
        <TokenDropdown
          selected={token}
          tokens={tokens}
          onSelect={onTokenSelect}
          exclude={excludeToken}
        />
      </div>
    </div>
  );
}

// ─── Main Widget ────────────────────────────────────────

interface SwapWidgetProps {
  onRouteComputed: (route: any) => void;
}

export default function SwapWidget({ onRouteComputed }: SwapWidgetProps) {
  const [tokenIn, setTokenIn] = useState('USDC');
  const [tokenOut, setTokenOut] = useState('PYUSD');
  const [amountIn, setAmountIn] = useState('');
  const [mode, setMode] = useState<'instant' | 'p2p'>('instant');
  const [loading, setLoading] = useState(false);
  const [quote, setQuote] = useState<any>(null);
  const [p2pPlan, setP2pPlan] = useState<any>(null);
  const { connected: walletConnected, address: walletAddress, connect: connectWallet } = useWallet();

  const handleSwapTokens = useCallback(() => {
    const prev = tokenIn;
    setTokenIn(tokenOut);
    setTokenOut(prev);
    setQuote(null);
    setP2pPlan(null);
  }, [tokenIn, tokenOut]);

  const handleGetQuote = useCallback(async () => {
    if (!amountIn || parseFloat(amountIn) <= 0) return;
    setLoading(true);
    try {
      const baseAmount = Math.floor(parseFloat(amountIn) * 1e7).toString();
      const data = await fetchQuote(tokenIn, tokenOut, baseAmount);
      setQuote(data);
      onRouteComputed(data);
    } catch (error) {
      console.error('Quote error:', error);
    } finally {
      setLoading(false);
    }
  }, [amountIn, tokenIn, tokenOut, onRouteComputed]);

  const handleP2pCheck = useCallback(async () => {
    if (!amountIn || parseFloat(amountIn) <= 0) return;
    setLoading(true);
    try {
      const baseAmount = Math.floor(parseFloat(amountIn) * 1e7).toString();
      const data = await buildPeerSwap({
        sourceAddress: walletAddress || 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        tokenIn,
        tokenOut,
        amountIn: baseAmount,
        minAmountOut: baseAmount,
      });
      setP2pPlan(data.plan);
    } catch (error) {
      console.error('P2P match check error:', error);
    } finally {
      setLoading(false);
    }
  }, [amountIn, tokenIn, tokenOut, walletAddress]);

  // Wallet connection is handled by the shared WalletContext

  const formatOutput = (raw: string) => {
    if (!raw) return '0.00';
    return (parseInt(raw) / 1e7).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  return (
    <div
      style={{
        background: '#131722',
        border: '1px solid #1a1f2e',
        borderRadius: '20px',
      }}
    >
      {/* Mode tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid #1a1f2e' }}>
        {([
          { key: 'instant' as const, label: 'Instant Swap', desc: 'Fills now via DEXs · venue fees only' },
          { key: 'p2p' as const, label: 'P2P Match', desc: 'Wait for a peer · 0.5 bps only' },
        ]).map((tab) => (
          <button
            key={tab.key}
            onClick={() => { setMode(tab.key); setQuote(null); setP2pPlan(null); }}
            style={{
              flex: 1,
              padding: '14px 16px 12px',
              background: 'transparent',
              border: 'none',
              borderBottom: mode === tab.key ? '2px solid #6366f1' : '2px solid transparent',
              cursor: 'pointer',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: '14px', fontWeight: 600, color: mode === tab.key ? '#e1e4ea' : '#565b68' }}>
              {tab.label}
            </div>
            <div style={{ fontSize: '11px', color: mode === tab.key ? '#6366f1' : '#3a3f4c', marginTop: '2px' }}>
              {tab.desc}
            </div>
          </button>
        ))}
      </div>

      <div style={{ padding: '18px' }}>
        {/* Selling */}
        <InputPanel
          label="Selling"
          sublabel="Balance: --"
          value={amountIn}
          onChange={(v) => { setAmountIn(v); setQuote(null); setP2pPlan(null); }}
          token={tokenIn}
          tokens={TOKENS}
          onTokenSelect={(s) => { setTokenIn(s); if (s === tokenOut) setTokenOut(tokenIn); setQuote(null); setP2pPlan(null); }}
          excludeToken={tokenOut}
          accent="#ef4444"
        />

        {/* Direction arrow */}
        <div style={{ display: 'flex', justifyContent: 'center', margin: '-6px 0', position: 'relative', zIndex: 2 }}>
          <button
            onClick={handleSwapTokens}
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '10px',
              background: '#1a1f2e',
              border: '3px solid #131722',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: '#8a8f9c',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#252a3a'; e.currentTarget.style.color = '#e1e4ea'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '#1a1f2e'; e.currentTarget.style.color = '#8a8f9c'; }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 2v10M7 12l3-3M7 12l-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* Buying */}
        <InputPanel
          label="Buying"
          sublabel="Balance: --"
          value={quote ? formatOutput(quote.netAmountOut) : ''}
          readOnly
          token={tokenOut}
          tokens={TOKENS}
          onTokenSelect={(s) => { setTokenOut(s); if (s === tokenIn) setTokenIn(tokenOut); setQuote(null); setP2pPlan(null); }}
          excludeToken={tokenIn}
          accent="#22c55e"
        />

        {/* P2P Match info */}
        {mode === 'p2p' && amountIn && parseFloat(amountIn) > 0 && (
          <div
            style={{
              marginTop: '12px',
              background: 'rgba(99, 102, 241, 0.06)',
              border: '1px solid rgba(99, 102, 241, 0.15)',
              borderRadius: '12px',
              padding: '12px 14px',
              fontSize: '13px',
              color: '#8a8f9c',
              lineHeight: '1.5',
            }}
          >
            <div style={{ fontWeight: 600, color: '#6366f1', marginBottom: '4px', fontSize: '12px' }}>
              P2P MATCH
            </div>

            {p2pPlan ? (
              // Show auto-match results
              <div>
                {p2pPlan.fills && p2pPlan.fills.length > 0 ? (
                  <>
                    <div style={{ color: '#22c55e', fontWeight: 600, marginBottom: '4px' }}>
                      {p2pPlan.fills.length} matching order{p2pPlan.fills.length > 1 ? 's' : ''} found
                    </div>
                    <div style={{ marginBottom: '6px' }}>
                      <strong style={{ color: '#e1e4ea' }}>
                        {(parseInt(p2pPlan.summary.instantFillAmount) / 1e7).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {tokenOut}
                      </strong>{' '}
                      fills instantly at <strong style={{ color: '#22c55e' }}>0.5 bps</strong>.
                    </div>
                    {p2pPlan.remainder && (
                      <div style={{ fontSize: '12px', color: '#eab308' }}>
                        Remaining{' '}
                        <strong>{(parseInt(p2pPlan.remainder.amountIn) / 1e7).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {tokenIn}</strong>{' '}
                        will be escrowed on-chain waiting for a future match.
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div>
                      No matching orders right now. Your{' '}
                      <strong style={{ color: '#e1e4ea' }}>{parseFloat(amountIn).toLocaleString()} {tokenIn}</strong>{' '}
                      will be escrowed on-chain and wait for a counterparty to match at{' '}
                      <strong style={{ color: '#22c55e' }}>0.5 bps</strong>.
                    </div>
                    <div style={{ marginTop: '6px', fontSize: '12px', color: '#565b68' }}>
                      *Could take minutes to days depending on demand. Cancel anytime to reclaim tokens.
                    </div>
                  </>
                )}
              </div>
            ) : (
              // Default info before checking
              <div>
                We&apos;ll check for matching orders first. Any matches fill instantly at{' '}
                <strong style={{ color: '#22c55e' }}>0.5 bps</strong>. Remainder is escrowed
                on-chain and waits for a future match. You can cancel anytime.
                <div style={{ marginTop: '6px', fontSize: '12px', color: '#565b68' }}>
                  *Cheapest option, but the wait could be minutes to days depending on demand.
                </div>
              </div>
            )}
          </div>
        )}

        {/* Quote details */}
        {quote && mode === 'instant' && (
          <div
            style={{
              marginTop: '12px',
              background: '#0d1117',
              borderRadius: '12px',
              padding: '12px 14px',
              border: '1px solid #161b26',
            }}
          >
            {[
              { label: 'Rate', value: `1 ${tokenIn} ≈ 1.0000 ${tokenOut}` },
              {
                label: 'Our fee',
                value: parseInt(quote.swapBookAmountOut ?? '0') > 0
                  ? `0.5 bps on P2P portion`
                  : 'None — all via DEXs',
                color: parseInt(quote.swapBookAmountOut ?? '0') > 0 ? '#22c55e' : '#8a8f9c',
              },
              { label: 'DEX venue costs', value: `~${Math.max(0, (quote.blendedBps ?? 0)).toFixed(1)} bps`, color: '#eab308' },
              { label: 'Total cost', value: `${(quote.blendedBps ?? 0).toFixed(1)} bps`, color: '#6366f1', bold: true },
            ].map((row: any) => (
              <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                <span style={{ fontSize: '13px', color: '#565b68' }}>{row.label}</span>
                <span style={{ fontSize: '13px', color: row.color || '#8a8f9c', fontWeight: row.bold ? 600 : 400 }}>
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Action button */}
        {!walletConnected ? (
          <button
            onClick={connectWallet}
            style={{
              width: '100%',
              marginTop: '16px',
              padding: '16px',
              borderRadius: '14px',
              border: 'none',
              background: 'linear-gradient(135deg, #6366f1, #7c3aed)',
              color: 'white',
              fontSize: '16px',
              fontWeight: 600,
              cursor: 'pointer',
              letterSpacing: '-0.2px',
            }}
          >
            Connect Wallet
          </button>
        ) : (
          <button
            onClick={
              mode === 'instant' && !quote
                ? handleGetQuote
                : mode === 'p2p' && !p2pPlan
                ? handleP2pCheck
                : undefined
            }
            disabled={!amountIn || parseFloat(amountIn) <= 0 || loading}
            style={{
              width: '100%',
              marginTop: '16px',
              padding: '16px',
              borderRadius: '14px',
              border: 'none',
              background: !amountIn || parseFloat(amountIn) <= 0
                ? '#1a1f2e'
                : 'linear-gradient(135deg, #6366f1, #7c3aed)',
              color: !amountIn || parseFloat(amountIn) <= 0 ? '#565b68' : 'white',
              fontSize: '16px',
              fontWeight: 600,
              cursor: !amountIn || parseFloat(amountIn) <= 0 || loading ? 'not-allowed' : 'pointer',
              letterSpacing: '-0.2px',
            }}
          >
            {loading
              ? mode === 'p2p' ? 'Checking for matches...' : 'Finding best route...'
              : mode === 'p2p'
              ? amountIn && parseFloat(amountIn) > 0
                ? p2pPlan
                  ? p2pPlan.fills?.length > 0
                    ? `Fill ${p2pPlan.fills.length} match${p2pPlan.fills.length > 1 ? 'es' : ''}${p2pPlan.remainder ? ' + escrow remainder' : ''}`
                    : `Escrow ${parseFloat(amountIn).toLocaleString()} ${tokenIn} · wait for P2P match`
                  : 'Find P2P matches'
                : 'Enter an amount'
              : quote
              ? `Swap ${parseFloat(amountIn).toLocaleString()} ${tokenIn} → ${formatOutput(quote.netAmountOut)} ${tokenOut}`
              : amountIn && parseFloat(amountIn) > 0
              ? 'Get Quote'
              : 'Enter an amount'}
          </button>
        )}

        {/* Connected wallet indicator */}
        {walletConnected && walletAddress && (
          <div style={{ textAlign: 'center', marginTop: '8px', fontSize: '12px', color: '#565b68' }}>
            Connected: {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
          </div>
        )}
      </div>
    </div>
  );
}
