// register_commands.js
// Registers GUILD commands (fast updates). If you want GLOBAL, change the route.

const DISCORD_API = "https://discord.com/api/v10";

const APPLICATION_ID = process.env.DISCORD_APP_ID;   // set in your shell
const GUILD_ID = process.env.DISCORD_GUILD_ID;       // set in your shell
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;     // set in your shell

if (!APPLICATION_ID || !GUILD_ID || !BOT_TOKEN) {
  console.error("Missing env vars. Set DISCORD_APP_ID, DISCORD_GUILD_ID, DISCORD_BOT_TOKEN.");
  process.exit(1);
}

async function putGuildCommands(commands) {
  const url = `${DISCORD_API}/applications/${APPLICATION_ID}/guilds/${GUILD_ID}/commands`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Discord API ${res.status}: ${text}`);
  }
  return text;
}

const commands = [
  {
    name: "help",
    description: "Show Tarkov Assist Bot help",
  },
  {
    name: "version",
    description: "Show bot version",
  },
  {
    name: "watch",
    description: "Watch an item until it reaches your max price",
    options: [
      {
        type: 3, // STRING
        name: "item",
        description: "Item name",
        required: true,
        autocomplete: true,
      },
      {
        type: 4, // INTEGER
        name: "max_price",
        description: "Alert when price is at or below this (RUB)",
        required: true,
      },
      {
        type: 5, // BOOLEAN
        name: "once",
        description: "Alert once then remove this watch",
        required: false,
      },
    ],
  },
  {
    name: "price",
    description: "Check current flea price for an item",
    options: [
      {
        type: 3, // STRING
        name: "item",
        description: "Item name",
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "listwatches",
    description: "List your current watches",
  },
  {
    name: "unwatch",
    description: "Remove a watch for an item",
    options: [
      {
        type: 3, // STRING
        name: "item",
        description: "Item name",
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "clearwatches",
    description: "Remove ALL your watches in this server",
  },
  {
    name: "syncitems",
    description: "(Admin) Sync the item dictionary from tarkov.dev",
  },
];

(async () => {
  try {
    console.log("Registering guild commands...");
    const out = await putGuildCommands(commands);
    console.log("✅ Success:", out);
  } catch (e) {
    console.error("❌ Failed:", e.message || e);
    process.exit(1);
  }
})();