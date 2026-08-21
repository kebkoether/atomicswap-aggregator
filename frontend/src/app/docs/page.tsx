const API_BASE = 'https://atomicswap-aggregator-production.up.railway.app';

const section: React.CSSProperties = {
  background: '#131722',
  border: '1px solid #252a3a',
  borderRadius: '14px',
  padding: '22px',
  marginBottom: '16px',
};
const h2: React.CSSProperties = { fontSize: '17px', fontWeight: 700, color: '#e1e4ea', marginBottom: '10px' };
const p: React.CSSProperties = { fontSize: '14px', color: '#8a8f9c', lineHeight: 1.65, marginBottom: '10px' };
const code: React.CSSProperties = {
  display: 'block',
  background: '#0d1117',
  border: '1px solid #1a1f2e',
  borderRadius: '8px',
  padding: '12px 14px',
  fontSize: '12.5px',
  color: '#c4cad6',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  whiteSpace: 'pre',
  overflowX: 'auto',
  marginBottom: '10px',
};

export const metadata = { title: 'Ufama — API Docs' };

export default function DocsPage() {
  return (
    <div style={{ maxWidth: '860px', margin: '0 auto', padding: '32px 24px 64px' }}>
      <h1 style={{ fontSize: '26px', fontWeight: 700, color: '#e1e4ea', marginBottom: '6px' }}>
        Integrator API
      </h1>
      <p style={{ ...p, marginBottom: '24px' }}>
        REST API for wallets and payment apps that want swaps on Stellar without running their
        own routing. Flow: <b style={{ color: '#e1e4ea' }}>quote → build → your user signs → send</b>.
        Ufama never sees keys — every transaction is signed client-side by your user&apos;s wallet.
      </p>

      <div style={section}>
        <div style={h2}>Base URL &amp; auth</div>
        <span style={code}>{API_BASE}</span>
        <p style={p}>
          Every <b>/v1</b> request needs an API key, sent as <b>x-api-key</b> or{' '}
          <b>Authorization: Bearer</b>. Keys are issued manually — email{' '}
          <a href="mailto:hello@ufama.trade" style={{ color: '#6366f1' }}>hello@ufama.trade</a>.
          Rate limit: 120 requests/min per key.
        </p>
      </div>

      <div style={section}>
        <div style={h2}>POST /v1/quote</div>
        <span style={code}>{`{
  "assetIn":  "XLM",            // symbol or SAC contract address
  "assetOut": "USDC",
  "amount":   "1000000000",     // base units (7 decimals), EXACT_IN
  "slippageBps": 50,            // optional, default 50
  "feeBps": 25,                 // optional partner fee, max 100 (1%)
  "referralAddress": "G..."     // required when feeBps > 0
}`}</span>
        <p style={p}>
          Returns <b>amountOut</b> (net of protocol fee and your partner fee),{' '}
          <b>minAmountOut</b>, <b>kind</b> (&quot;classic&quot; or &quot;soroban&quot;),{' '}
          <b>partnerFee</b>, <b>partnerFeeCollected</b>, and the venue{' '}
          <b>segments</b>. Quotes are indicative; build re-prices.
        </p>
      </div>

      <div style={section}>
        <div style={h2}>POST /v1/quote/build</div>
        <p style={p}>
          Same body plus <b>from</b> (the user address that will sign). Returns an unsigned{' '}
          <b>xdr</b>. Hand it to the user&apos;s wallet (Freighter, xBull, LOBSTR — any SEP-43
          signer) and have them sign against{' '}
          <b>Public Global Stellar Network ; September 2015</b>.
        </p>
        <p style={p}>
          <b>Partner economics:</b> on classic (SDEX) routes your <b>feeBps</b> is a second
          payment op inside the same transaction — atomic with the swap, paid in the output
          asset. Your <b>referralAddress</b> must hold a trustline for every output asset you
          enable. Soroban routes report <b>partnerFeeCollected: false</b> for now.
        </p>
      </div>

      <div style={section}>
        <div style={h2}>POST /v1/send</div>
        <span style={code}>{`{ "xdr": "<signed transaction XDR>" }`}</span>
        <p style={p}>
          Submits and returns the result. You can also submit yourself via Horizon (classic) or
          Soroban RPC (soroban) if you prefer.
        </p>
      </div>

      <div style={section}>
        <div style={h2}>GET /v1/tokens · GET /v1/health</div>
        <p style={p}>
          <b>/v1/tokens</b>: the tradeable universe with contract addresses and venue-volume
          ranking (sort by <b>venueVolume</b> for a &quot;top tokens&quot; list).{' '}
          <b>/v1/health</b>: auth check — echoes which partner your key belongs to.
        </p>
      </div>

      <div style={section}>
        <div style={h2}>Contact</div>
        <p style={{ ...p, marginBottom: 0 }}>
          API keys, integration help, or anything else:{' '}
          <a href="mailto:hello@ufama.trade" style={{ color: '#6366f1' }}>hello@ufama.trade</a>
        </p>
      </div>
    </div>
  );
}
