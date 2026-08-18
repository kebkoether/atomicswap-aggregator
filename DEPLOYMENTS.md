# Deployments

## Mainnet (canary — unannounced, dust-tested 2026-08-17)

| Contract | Address |
|---|---|
| FeeVault | `CAIBVO2HVR77N6ZMUNFG23ORBONCJGKN7WSBYSMSDUFYTC43YJVASOWI` |
| SwapBook | `CBPTU2MADELJOEPJWJIJUYXM36YFKQYMECNDIW6SFLZZ3XKABGZ44SVF` |
| Router | `CD4EKANBDBF5NNV6BNJVPIHGZLLUKEXBB3QXZ3QWPOX5LNCEFPOJ2J6I` |
| TwapBook | `CAMZXFZCGAQNVEMNV56W4ZTCY3ELUGQROXVXFWGCECUNQ3ZA3AQT3Q2Z` |
| Aqua adapter (v3) | `CC3P5UNO6PBVAKKQ7A6SJZ6G566X3VF2XNH5BFI7A3VFUGIMNPOP2HDY` |

Admin/deployer: `GB3BIN23PHTOPHTEGTC4VCY2HVSY6HDYG3C6QXQQ3TCEJR74K6DWGMQT`
Aqua pool registered on the adapter: XLM/USDC constant-product
`CA6PUJLBYKZKUEKLZJMKBZLEKP2OTHANDEOWSFF44FTSYLKQPIICCJBE`
(hash `b2e02fcf…aab7f0`). Venue 1 = Aqua on both Router and TwapBook.

Verified with dust-sized real transactions: instant swap via Aqua
(fee exact at 0.5 bps ceil), P2P place/quote/fill, TWAP place +
permissionless slice + live AheadOfSchedule rejection + cancel refund,
FeeVault withdrawal. **Contracts are unaudited — do not publicize or
route size until the audit line in the deployment plan is met.**

Superseded mainnet adapters (do not use): `CCYFDTWA…GR22` (v2, auth fix
mis-ordered), plus one v1 with the allowance-based flow.

## Testnet (2026-08-13)

| Contract | Address |
|---|---|
| FeeVault | `CAE7OFX4PJZ3YXP7WHSHGG6YGA2SOR6WBWCHCNRO4YIDXEYQYHMMAJPC` |
| SwapBook | `CBHLP5NVC4MW5IW5LADGQHHH35LSDY2P6LM5RABKPGXVZVTYKGJJY3NI` |
| Router | `CDHWQFVZ7CIUZQL334ZQW2IEINCM3H66SZD77WO2IQ2NBUTKO2UF35LR` |
| TwapBook | `CCL6X6X5YWCHVFFDLX63TCIV4R2GTEHEZPEHG4TJLVIOP52DXJ7YQHMH` |
| Aqua adapter | `CBJTYQG3V2VC2KSMNT4KRXRULU6FSGWXX2AT453QZBGI2AFHKZREIBUH` |

Test assets USDC / USDT0 issued by the testnet deployer
`GBSFQ5KPAH76PGXVG2WIJFOAEYZNUIZDYVWACGLK7JXTBVKDA4H6MGDY`.
Note: Stellar testnet resets quarterly — these expire with it.
