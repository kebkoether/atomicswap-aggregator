'use client';

import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@/context/WalletContext';
import { getUserOrders, buildCancelOrder, submitTransaction } from '@/lib/api';

interface Order {
  id: number;
  maker: string;
  token_in: string;
  token_out: string;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  amount_in: string;
  amount_in_remaining: string;
  min_amount_out: string;
  status: string;
  created_at: number;
  expiry: number;
}

const STATUS_STYLES: Record<string, { color: string; bg: string; label: string }> = {
  Open: { color: '#22c55e', bg: 'rgba(34, 197, 94, 0.1)', label: 'Open' },
  PartialFill: { color: '#eab308', bg: 'rgba(234, 179, 8, 0.1)', label: 'Partial Fill' },
  Filled: { color: '#6366f1', bg: 'rgba(99, 102, 241, 0.1)', label: 'Filled' },
  Cancelled: { color: '#565b68', bg: 'rgba(86, 91, 104, 0.1)', label: 'Cancelled' },
  Expired: { color: '#ef4444', bg: 'rgba(239, 68, 68, 0.1)', label: 'Expired' },
};

function formatAmount(raw: string): string {
  const val = parseInt(raw || '0');
  return (val / 1e7).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fillPercent(amountIn: string, remaining: string): number {
  const total = parseInt(amountIn || '0');
  const rem = parseInt(remaining || '0');
  if (total <= 0) return 0;
  return Math.round(((total - rem) / total) * 100);
}

export default function OrdersPage() {
  const { connected, address, signTransaction } = useWallet();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState<number | null>(null);

  const fetchOrders = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    try {
      const userOrders = await getUserOrders(address);
      setOrders(userOrders || []);
    } catch (err) {
      console.error('Failed to fetch orders:', err);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    if (connected && address) {
      fetchOrders();
    }
  }, [connected, address, fetchOrders]);

  const handleCancel = useCallback(
    async (orderId: number) => {
      if (!address) return;
      setCancelling(orderId);
      try {
        // 1. Build the cancel transaction
        const { xdr } = await buildCancelOrder(address, orderId);

        if (!xdr) {
          throw new Error('Failed to build cancel transaction');
        }

        // 2. Sign with Freighter
        const signedXdr = await signTransaction(xdr);

        // 3. Submit
        const result = await submitTransaction(signedXdr);

        if (result.status === 'SUCCESS') {
          await fetchOrders();
        }
      } catch (err) {
        console.error('Cancel failed:', err);
      } finally {
        setCancelling(null);
      }
    },
    [address, signTransaction, fetchOrders]
  );

  const openOrders = orders.filter((o) => o.status === 'Open' || o.status === 'PartialFill');
  const pastOrders = orders.filter((o) => o.status !== 'Open' && o.status !== 'PartialFill');

  return (
    <div style={{ maxWidth: '640px', margin: '0 auto', padding: '40px 16px 80px' }}>
      <h1
        style={{
          fontSize: '24px',
          fontWeight: 700,
          color: '#e1e4ea',
          letterSpacing: '-0.5px',
          marginBottom: '8px',
        }}
      >
        Your Orders
      </h1>
      <p style={{ fontSize: '14px', color: '#8a8f9c', marginBottom: '28px' }}>
        P2P match orders placed through the SwapBook. Open orders are escrowed on-chain.
      </p>

      {!connected ? (
        <div
          style={{
            background: '#131722',
            border: '1px solid #1a1f2e',
            borderRadius: '16px',
            padding: '48px 24px',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '40px', marginBottom: '16px' }}>&#x1f512;</div>
          <div style={{ fontSize: '16px', fontWeight: 600, color: '#e1e4ea', marginBottom: '8px' }}>
            Connect your wallet
          </div>
          <div style={{ fontSize: '14px', color: '#8a8f9c' }}>
            Connect Freighter to view your open orders.
          </div>
        </div>
      ) : loading ? (
        <div
          style={{
            background: '#131722',
            border: '1px solid #1a1f2e',
            borderRadius: '16px',
            padding: '48px 24px',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '14px', color: '#8a8f9c' }} className="animate-pulse">
            Loading orders...
          </div>
        </div>
      ) : orders.length === 0 ? (
        <div
          style={{
            background: '#131722',
            border: '1px solid #1a1f2e',
            borderRadius: '16px',
            padding: '48px 24px',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '40px', marginBottom: '16px' }}>&#x1f4ed;</div>
          <div style={{ fontSize: '16px', fontWeight: 600, color: '#e1e4ea', marginBottom: '8px' }}>
            No orders yet
          </div>
          <div style={{ fontSize: '14px', color: '#8a8f9c', marginBottom: '20px' }}>
            Place a P2P Match order to get started.
          </div>
          <a
            href="/"
            style={{
              display: 'inline-block',
              background: 'linear-gradient(135deg, #6366f1, #7c3aed)',
              color: 'white',
              borderRadius: '10px',
              padding: '10px 24px',
              fontSize: '14px',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Go to Swap
          </a>
        </div>
      ) : (
        <>
          {/* Open orders */}
          {openOrders.length > 0 && (
            <div style={{ marginBottom: '32px' }}>
              <div
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  color: '#565b68',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  marginBottom: '12px',
                }}
              >
                Open ({openOrders.length})
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {openOrders.map((order) => {
                  const status = STATUS_STYLES[order.status] || STATUS_STYLES.Open;
                  const filled = fillPercent(order.amount_in, order.amount_in_remaining);

                  return (
                    <div
                      key={order.id}
                      style={{
                        background: '#131722',
                        border: '1px solid #1a1f2e',
                        borderRadius: '14px',
                        padding: '16px 18px',
                      }}
                    >
                      {/* Top row: pair + status */}
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: '12px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ fontSize: '15px', fontWeight: 600, color: '#e1e4ea' }}>
                            {order.tokenInSymbol} → {order.tokenOutSymbol}
                          </span>
                          <span style={{ fontSize: '12px', color: '#565b68' }}>
                            #{order.id}
                          </span>
                        </div>
                        <span
                          style={{
                            fontSize: '11px',
                            fontWeight: 600,
                            color: status.color,
                            background: status.bg,
                            padding: '3px 8px',
                            borderRadius: '6px',
                          }}
                        >
                          {status.label}
                        </span>
                      </div>

                      {/* Amounts row */}
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'flex-end',
                          marginBottom: '12px',
                        }}
                      >
                        <div>
                          <div style={{ fontSize: '12px', color: '#565b68', marginBottom: '2px' }}>
                            Selling
                          </div>
                          <div style={{ fontSize: '18px', fontWeight: 600, color: '#e1e4ea' }}>
                            {formatAmount(order.amount_in)}{' '}
                            <span style={{ fontSize: '13px', color: '#8a8f9c' }}>
                              {order.tokenInSymbol}
                            </span>
                          </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: '12px', color: '#565b68', marginBottom: '2px' }}>
                            Min. receiving
                          </div>
                          <div style={{ fontSize: '18px', fontWeight: 600, color: '#e1e4ea' }}>
                            {formatAmount(order.min_amount_out)}{' '}
                            <span style={{ fontSize: '13px', color: '#8a8f9c' }}>
                              {order.tokenOutSymbol}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Fill progress bar */}
                      <div style={{ marginBottom: '14px' }}>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            marginBottom: '4px',
                          }}
                        >
                          <span style={{ fontSize: '12px', color: '#565b68' }}>Filled</span>
                          <span style={{ fontSize: '12px', color: '#8a8f9c', fontWeight: 500 }}>
                            {filled}%
                          </span>
                        </div>
                        <div
                          style={{
                            height: '4px',
                            borderRadius: '2px',
                            background: '#1a1f2e',
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              height: '100%',
                              width: `${filled}%`,
                              borderRadius: '2px',
                              background:
                                filled === 100
                                  ? '#22c55e'
                                  : 'linear-gradient(90deg, #6366f1, #8b5cf6)',
                              transition: 'width 0.3s ease',
                            }}
                          />
                        </div>
                      </div>

                      {/* Remaining + Cancel */}
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <span style={{ fontSize: '12px', color: '#565b68' }}>
                          {formatAmount(order.amount_in_remaining)} {order.tokenInSymbol} remaining
                        </span>
                        <button
                          onClick={() => handleCancel(order.id)}
                          disabled={cancelling === order.id}
                          style={{
                            background: 'transparent',
                            border: '1px solid #252a3a',
                            borderRadius: '8px',
                            padding: '6px 14px',
                            fontSize: '12px',
                            fontWeight: 600,
                            color: '#ef4444',
                            cursor: cancelling === order.id ? 'wait' : 'pointer',
                            opacity: cancelling === order.id ? 0.5 : 1,
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.borderColor = '#ef4444';
                            e.currentTarget.style.background = 'rgba(239, 68, 68, 0.08)';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.borderColor = '#252a3a';
                            e.currentTarget.style.background = 'transparent';
                          }}
                        >
                          {cancelling === order.id ? 'Cancelling...' : 'Cancel Order'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Past orders */}
          {pastOrders.length > 0 && (
            <div>
              <div
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  color: '#565b68',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  marginBottom: '12px',
                }}
              >
                History ({pastOrders.length})
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {pastOrders.map((order) => {
                  const status = STATUS_STYLES[order.status] || STATUS_STYLES.Cancelled;

                  return (
                    <div
                      key={order.id}
                      style={{
                        background: '#131722',
                        border: '1px solid #1a1f2e',
                        borderRadius: '12px',
                        padding: '12px 16px',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        opacity: 0.6,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <span style={{ fontSize: '14px', fontWeight: 500, color: '#8a8f9c' }}>
                          {order.tokenInSymbol} → {order.tokenOutSymbol}
                        </span>
                        <span style={{ fontSize: '13px', color: '#565b68' }}>
                          {formatAmount(order.amount_in)} {order.tokenInSymbol}
                        </span>
                      </div>
                      <span
                        style={{
                          fontSize: '11px',
                          fontWeight: 600,
                          color: status.color,
                          background: status.bg,
                          padding: '3px 8px',
                          borderRadius: '6px',
                        }}
                      >
                        {status.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
