# GYRE · read the current

A multi-chain trading terminal for **Solana** and **Robinhood Chain**, built on one rule: show the evidence before the opinion. Built on the NYX engine, with its own brand, layout and depth-themed interface; the scroll morph is the NYX one, re-lit.

What a visitor gets:

- **Discover**: Trending, New pairs, Gainers 1h, Volume and Curve tabs over a live universe of pairs (DexScreener + the chains), one row per token with buy share, flow and the last verdict.
- **Signals that explain themselves**: buy/sell surges sized against the pool, liquidity pulls and adds, ±12% moves, new pairs, paid boosts, and on Robinhood Chain exact Pons curve whale buys/sells with wallet and hash. Streamed over SSE.
- **Scam check you can audit**: chain-specific steps (Solana: mint/freeze authority, token-2022 extensions, holder concentration with pools separated, launcher funding trail · Robinhood: owner and EIP-1967 proxy slots, Pons launch record, holder distribution from Transfer logs, deployer launch history), each with explorer links, then the analyst's scored verdict with flags, clean checks, what is missing and what would change its mind.
- **Forecasts graded in public**: direction, range, confidence, invalidation; stored with the price now, re-read at the horizon and scored. Hit rates on `/record`.
- **Ask GYRE**: a sentence becomes discover filters.
- **Swaps, non-custodial**: Jupiter on Solana, the Pons curve on Robinhood Chain; GYRE builds, the wallet signs.
- **$GYRE tiers**: Free / Holder / Holder+ analyst quotas, read from the chain. Studio sets the CA, tiers, quotas, the wallet gate, the banner, modules, the x402 treasury and relayer.
- **Agent API**: free JSON reads plus a paid scan (`/api/v1/pro/scan/:chain/:pair`) through GYRE's own x402 facilitator (USDG, USDC, $GYRE via Permit2).

The analyst is called GYRE everywhere and only reads facts the server already gathered.

```
server/   Node 20+, ESM, Express 5. lib/: dex (DexScreener + universe + feeds), sol, rh (chain reads), signals,
          scan (pipeline), ai (analyst), record (track record), swap (builders), access (tiers), x402 (facilitator), pons.
site/     static pages: index (the dive: 3D morph over five depth chapters), discover, terminal (/t/:chain/:pair), ask, record, dashboard, docs, studio.
deploy/   deploy.sh, nginx conf, pm2 ecosystem (domain placeholder gyre.trade).
```

## Run

```
cd server && cp .env.example .env   # fill ANTHROPIC_API_KEY, STUDIO_KEY, GYRE_SECRET
npm install && npm start            # http://localhost:5120
```

Data sources, all public: DexScreener API (60 s cache, 30-address batches), Solana RPC (publicnode for account reads, mainnet-beta for indexed calls; set `SOLANA_RPC` to a free Helius/Alchemy endpoint for holder scans at scale), Robinhood Chain RPC through `lib/pons.js` (shared gate + retry), Jupiter lite API for Solana swaps.

## Honesty rules

- No number on the site is typed by hand: every price, volume, holder share or balance is read from DexScreener or the chain at request time.
- The analyst never sees anything the server did not gather. Missing facts are reported as missing, never as safe.
- Forecasts and verdicts are append-only. The record page shows the misses.
- GYRE never holds funds. Wallet sessions are one signed message; swaps are built, never sent.

## X content kit
`konten-x/` holds the launch kit: `pre/` (12 before launch), `ca/` (3 for the contract post), `post/` (12 after launch), `profil/` (avatar + banner) and `captions.txt` with every caption in order.
Live-data cards are rendered from the running engine: `node konten-x/_tools/build.mjs` (local server on :5120 must be up) re-renders every image with fresh numbers.
Videos: `_tools/frames.mjs` (deterministic CSS-animation frames), `_tools/rec2.mjs` + `_tools/encode.sh` (screencasts with captions).

## $GYRE on the site: CA, Buy, buyback & burn
Studio 01 sets the contract address (must be a Pons token). The moment it is saved the CA bar appears on every page with COPY, **BUY** (in-site buy sheet: the server quotes the Pons curve, the visitor's wallet signs, GYRE never holds funds) and TERMINAL. Studio 08 stores a separate burn wallet key (sealed with `GYRE_SECRET`), Studio 09 runs a buyback & burn: the curve buy is sent with the dead address as recipient, capped by `BURN_MAX_USD` per run and `BURN_DAY_USD` per rolling day; every burn is listed publicly on /dashboard with its hash.
