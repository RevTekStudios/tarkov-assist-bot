# 🎯 Tarkov Assist Bot

A Discord bot that monitors Escape from Tarkov flea market prices and
alerts users when a specified price threshold is reached.

Built using:

-   ⚡ Cloudflare Workers\
-   🗄 Cloudflare D1 (SQLite)\
-   🎮 Discord Interactions API\
-   📊 tarkov.dev GraphQL API

------------------------------------------------------------------------

## 🚀 Features

-   `/watch` -- Monitor an item for a target max price
-   `/listwatches` -- View your active watches
-   `/unwatch` -- Remove a watch
-   `/syncitems` -- (Admin) Import full Tarkov item dictionary
-   Autocomplete for item names
-   Automatic price polling via scheduled cron job
-   Per-user cooldown system
-   Optional one-time alert mode

------------------------------------------------------------------------

## 🏗 Architecture

Discord → Cloudflare Worker → D1 Database → tarkov.dev GraphQL

A scheduled cron job runs every minute to check prices and notify users.

All secrets are stored securely in Cloudflare and never committed to the
repository.

------------------------------------------------------------------------

## 🔧 Setup

### 1️⃣ Install Dependencies

``` bash
npm install
```

### 2️⃣ Login to Cloudflare

``` bash
npx wrangler login
```

### 3️⃣ Deploy the Worker

``` bash
npm run deploy
```

------------------------------------------------------------------------

## 🔐 Required Secrets

These must be added via Wrangler:

``` bash
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put ADMIN_USER_IDS
```

Example format for `ADMIN_USER_IDS`:

    123456789012345678,987654321098765432

------------------------------------------------------------------------

## 🗄 D1 Database Setup

Create database:

``` bash
npx wrangler d1 create flea_bot_db
```

Run schema:

``` bash
npx wrangler d1 execute flea_bot_db --file=./schema.sql --remote
```

------------------------------------------------------------------------

## 🧠 Import Item Dictionary

Before using `/watch`, run:

    /syncitems

This imports all Tarkov items from tarkov.dev into D1.

------------------------------------------------------------------------

## ⏱ Scheduled Price Checks

Cron schedule:

``` json
"* * * * *"
```

The worker:

-   Checks all active watches
-   Pulls live price data from tarkov.dev
-   Alerts users if threshold is met
-   Applies cooldown or removes one-time watches

------------------------------------------------------------------------

## 📊 Price Logic

Price priority:

1.  `avg24hPrice`
2.  `lastLowPrice`

Vendor prices are NOT used for flea alerts.

------------------------------------------------------------------------

## 🛡 Security

-   All Discord requests are signature verified
-   Secrets stored securely in Cloudflare
-   No tokens committed to the repository
-   No public database exposure

------------------------------------------------------------------------

## 🧪 Development

Tail logs:

``` bash
npx wrangler tail
```

Deploy:

``` bash
npm run deploy
```

------------------------------------------------------------------------

## 🗺 Roadmap

-   Smarter fuzzy matching
-   Better alert formatting
-   Price history tracking
-   Per-guild configuration
-   Web dashboard (future possibility)

------------------------------------------------------------------------

## 📌 Legal Notice

This project uses the public API provided by:

https://tarkov.dev

Escape from Tarkov is a registered trademark of Battlestate Games.

This bot is not affiliated with or endorsed by Battlestate Games.
