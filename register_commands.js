// discord/register_commands.js
const APP_ID = process.env.APP_ID;
const GUILD_ID = process.env.GUILD_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!APP_ID || !GUILD_ID || !BOT_TOKEN) {
  console.error("Missing env vars. Set APP_ID, GUILD_ID, DISCORD_BOT_TOKEN.");
  process.exit(1);
}

const API_BASE = "https://discord.com/api/v10";

const commands = [
  {
    name: "watch",
    description: "Watch an item and ping when it hits your target price.",
    options: [
      {
        name: "item",
        description: "Item name (start typing to search)",
        type: 3, // STRING
        required: true,
        autocomplete: true
      },
      {
        name: "max_price",
        description: "Max price (RUB) to alert at or below",
        type: 4, // INTEGER
        required: true
      },
      {
        name: "once",
        description: "Alert only once then remove",
        type: 5, // BOOLEAN
        required: false
      }
    ]
  },
  {
    name: "listwatches",
    description: "Show your current watch list."
  },
  {
    name: "unwatch",
    description: "Remove a watch rule.",
    options: [
      {
        name: "item",
        description: "Item name (start typing to search)",
        type: 3, // STRING
        required: true,
        autocomplete: true
      }
    ]
  },
  {
    name: "syncitems",
    description: "Admin: Sync Tarkov item dictionary into D1"
  },
  {
    name: "help",
    description: "Show help."
  }
];

async function discordFetch(path, method, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Discord API ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

(async () => {
  try {
    console.log("Registering guild commands...");
    await discordFetch(
      `/applications/${APP_ID}/guilds/${GUILD_ID}/commands`,
      "PUT",
      commands
    );
    console.log("✅ Done. Commands should update in your server within seconds.");
    console.log("Try typing /watch and start typing in the item field.");
  } catch (err) {
    console.error("❌ Failed:", err.message);
    process.exit(1);
  }
})();