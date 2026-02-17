// src/index.js
import { verifyKey } from "discord-interactions";

const TARKOV_GQL = "https://api.tarkov.dev/graphql";

// ====== Version ======
const BOT_VERSION = "0.2.0";

// ====== Tuning knobs ======
const COOLDOWN_MINUTES = 10;        // cooldown after alert (non-once watches)
const WEEKLY_REFRESH = true;        // keep weekly dictionary refresh
const DEBUG_PRICES = false;         // log price raw fields
const MAX_WATCHES_PER_USER = 25;    // watch limit per user per guild
const MAX_WATCHES_PER_GUILD = 500;  // watch limit per guild

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });

async function followup(interaction, payload) {
  // payload can be { content } OR { content, embeds }
  return fetch(
    `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
}

async function sendChannelMessage(env, channelId, payload) {
  // payload can be { content } OR { content, embeds }
  return fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

function nameKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function formatRUB(n) {
  const num = Number(n || 0);
  if (!Number.isFinite(num)) return "0 ₽";
  return `${num.toLocaleString()} ₽`;
}

// ADMIN allow-list (comma-separated user IDs in a Worker secret or env var)
function isAdmin(env, userId) {
  const raw = (env.ADMIN_USER_IDS || "").trim();
  if (!raw) return false;
  const set = new Set(raw.split(",").map((x) => x.trim()).filter(Boolean));
  return set.has(String(userId));
}

async function gql(query, variables = {}) {
  const res = await fetch(TARKOV_GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`tarkov.dev HTTP ${res.status}`);
  if (!data) throw new Error("tarkov.dev bad json");
  if (data.errors?.length) {
    throw new Error(`tarkov.dev gql error: ${data.errors[0]?.message || "unknown"}`);
  }
  return data.data;
}

async function metaGet(env, key) {
  const row = await env.flea_bot_db
    .prepare(`SELECT value FROM meta WHERE key=? LIMIT 1`)
    .bind(key)
    .first();
  return row?.value ?? null;
}

async function metaSet(env, key, value) {
  await env.flea_bot_db
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    )
    .bind(key, String(value))
    .run();
}

/**
 * Resolve to an item record (id + canonical name + short name) from D1.
 */
async function resolveItemFromD1(env, itemName) {
  const key = nameKey(itemName);

  // Exact
  const exact = await env.flea_bot_db
    .prepare(`SELECT id, name, short_name FROM items WHERE name_key=? LIMIT 1`)
    .bind(key)
    .first();
  if (exact?.id) return exact;

  // Loose
  const like = await env.flea_bot_db
    .prepare(`SELECT id, name, short_name FROM items WHERE name_key LIKE ? LIMIT 1`)
    .bind(`%${key}%`)
    .first();
  if (like?.id) return like;

  return null;
}

async function importAllItemsIntoD1(env) {
  const query = `
    query {
      items {
        id
        name
        shortName
      }
    }
  `;

  const data = await gql(query);
  const items = data?.items || [];
  if (!Array.isArray(items) || !items.length) {
    throw new Error("No items returned from tarkov.dev");
  }

  const CHUNK = 400;
  for (let i = 0; i < items.length; i += CHUNK) {
    const slice = items.slice(i, i + CHUNK);

    const stmts = slice.map((it) =>
      env.flea_bot_db
        .prepare(
          `INSERT INTO items (id, name, short_name, name_key)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name=excluded.name,
             short_name=excluded.short_name,
             name_key=excluded.name_key`
        )
        .bind(it.id, it.name, it.shortName || "", nameKey(it.name))
    );

    await env.flea_bot_db.batch(stmts);
  }

  await metaSet(env, "items_last_sync_ms", Date.now());
  await metaSet(env, "items_count", items.length);
  return items.length;
}

/**
 * Fetch item flea-ish prices from tarkov.dev.
 * Priority:
 *  1) avg24hPrice
 *  2) lastLowPrice
 */
async function getMarketPriceRUB(itemId) {
  const q = `
    query ($id: ID!) {
      item(id: $id) {
        id
        name
        avg24hPrice
        lastLowPrice
      }
    }
  `;

  const d = await gql(q, { id: itemId });
  const it = d?.item;

  if (!it?.id) return { ok: false, name: null, price: 0, raw: null };

  const avg = typeof it.avg24hPrice === "number" ? it.avg24hPrice : 0;
  const low = typeof it.lastLowPrice === "number" ? it.lastLowPrice : 0;

  const price = (avg > 0 ? avg : 0) || (low > 0 ? low : 0) || 0;

  return {
    ok: true,
    name: it.name || null,
    price,
    raw: DEBUG_PRICES ? { avg, low } : null,
  };
}

/**
 * Autocomplete helper (Discord Interaction type 4)
 */
async function autocompleteItems(env, userTyped) {
  const q = nameKey(userTyped);
  const pattern = q ? `%${q}%` : `%`;

  // 1) Exact-start matches first, then contains; shortest keys first
  const rows = await env.flea_bot_db
    .prepare(
      `SELECT name, short_name
       FROM items
       WHERE name_key LIKE ?
       ORDER BY
         CASE WHEN name_key LIKE ? THEN 0 ELSE 1 END,
         LENGTH(name_key) ASC
       LIMIT 25`
    )
    .bind(pattern, q ? `${q}%` : `%`)
    .all();

  const results = rows?.results || [];
  return results.map((r) => ({
    name: r.short_name ? `${r.name} (${r.short_name})` : r.name,
    value: r.name, // what gets fed back to the command
  }));
}

async function countUserWatches(env, guildId, userId) {
  const row = await env.flea_bot_db
    .prepare(`SELECT COUNT(1) AS c FROM watches WHERE guild_id=? AND user_id=?`)
    .bind(guildId, userId)
    .first();
  return Number(row?.c || 0);
}

async function countGuildWatches(env, guildId) {
  const row = await env.flea_bot_db
    .prepare(`SELECT COUNT(1) AS c FROM watches WHERE guild_id=?`)
    .bind(guildId)
    .first();
  return Number(row?.c || 0);
}

function buildPriceEmbed({ title, current, target, note }) {
  const desc =
    `💰 Current: **${formatRUB(current)}**\n` +
    (target ? `🎯 Target: **${formatRUB(target)}**\n` : "") +
    (note ? `ℹ️ ${note}\n` : "");

  return {
    title,
    description: desc.trim(),
  };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("OK", { status: 200 });

    const signature = request.headers.get("X-Signature-Ed25519") || "";
    const timestamp = request.headers.get("X-Signature-Timestamp") || "";
    const body = await request.text();

    if (!signature || !timestamp) return new Response("Missing signature headers", { status: 401 });

    const valid = await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY);
    if (!valid) return new Response("Bad signature", { status: 401 });

    let interaction;
    try {
      interaction = JSON.parse(body);
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }

    // Ping
    if (interaction.type === 1) return json({ type: 1 });

    // Autocomplete
    if (interaction.type === 4) {
      const focused = interaction.data?.options?.find((o) => o.focused);
      const typed = focused?.value ? String(focused.value) : "";

      let choices = [];
      try {
        if (focused?.name === "item") {
          choices = await autocompleteItems(env, typed);
        }
      } catch (e) {
        console.error("Autocomplete error:", e);
        choices = [];
      }

      return json({
        type: 8, // AUTOCOMPLETE RESULT
        data: { choices },
      });
    }

    // Slash commands
    if (interaction.type === 2) {
      const name = interaction.data?.name || "unknown";
      const opts = interaction.data?.options || [];
      const opt = (key) => opts.find((o) => o.name === key)?.value;

      const guildId = interaction.guild_id || "";
      const channelId = interaction.channel_id || "";
      const userId = interaction.member?.user?.id || interaction.user?.id || "";

      // Defer to avoid 3s timeouts
      const deferred = json({ type: 5 });

      ctx.waitUntil(
        (async () => {
          try {
            if (!guildId || !channelId || !userId) {
              await followup(interaction, { content: "⚠️ Missing guild/channel/user context." });
              return;
            }

            // Help
            if (name === "help") {
              await followup(interaction, {
                content:
                  "🧠 **Tarkov Assist Bot**\n" +
                  "• `/watch item max_price [once]` — watch a flea price\n" +
                  "• `/price item` — check current flea price\n" +
                  "• `/listwatches` — show your watches\n" +
                  "• `/unwatch item` — remove a watch\n" +
                  "• `/clearwatches` — remove ALL your watches\n" +
                  "• `/syncitems` — (admin) refresh local item dictionary\n" +
                  "• `/version` — show bot version\n",
              });
              return;
            }

            // Version
            if (name === "version") {
              await followup(interaction, { content: `✅ Tarkov Assist Bot version **${BOT_VERSION}**` });
              return;
            }

            // Admin: sync items
            if (name === "syncitems") {
              if (!isAdmin(env, userId)) {
                await followup(interaction, { content: "⛔ This command is admin-only." });
                return;
              }
              await followup(interaction, { content: "⏳ Syncing item dictionary from tarkov.dev…" });
              const count = await importAllItemsIntoD1(env);
              await followup(interaction, { content: `✅ Synced **${count.toLocaleString()}** items into D1.` });
              return;
            }

            // Safety: must have items loaded for item-based commands
            const itemsCount = Number((await metaGet(env, "items_count")) || 0);
            if (!itemsCount && ["watch", "price", "unwatch"].includes(name)) {
              await followup(interaction, {
                content: "⚠️ Item dictionary is empty.\nRun `/syncitems` (admin) once to import all items.",
              });
              return;
            }

            // /price
            if (name === "price") {
              const userItem = String(opt("item") || "").trim();
              if (!userItem) {
                await followup(interaction, { content: "⚠️ Usage: `/price item:<name>`" });
                return;
              }

              const rec = await resolveItemFromD1(env, userItem);
              if (!rec?.id) {
                await followup(interaction, {
                  content: `❓ Couldn’t match **${userItem}** in the local dictionary.`,
                });
                return;
              }

              const market = await getMarketPriceRUB(rec.id);
              if (!market.ok || !market.price) {
                await followup(interaction, { content: `ℹ️ No flea price available right now for **${rec.name}**.` });
                return;
              }

              await followup(interaction, {
                content: "",
                embeds: [buildPriceEmbed({ title: `📈 ${rec.name}`, current: market.price })],
              });
              return;
            }

            // /clearwatches
            if (name === "clearwatches") {
              const result = await env.flea_bot_db
                .prepare(`DELETE FROM watches WHERE guild_id=? AND user_id=?`)
                .bind(guildId, userId)
                .run();

              const deleted = result?.meta?.changes || 0;
              await followup(interaction, { content: `🧹 Cleared **${deleted}** watch(es).` });
              return;
            }

            // /watch
            if (name === "watch") {
              const userItem = String(opt("item") || "").trim();
              const maxPrice = Number(opt("max_price") || 0);
              const once = Boolean(opt("once") || false);

              if (!userItem || !Number.isFinite(maxPrice) || maxPrice < 1) {
                await followup(interaction, { content: "⚠️ Usage: `/watch item:<name> max_price:<number>`" });
                return;
              }

              // Limits (before insert)
              const userCount = await countUserWatches(env, guildId, userId);
              const guildCount = await countGuildWatches(env, guildId);

              if (userCount >= MAX_WATCHES_PER_USER) {
                await followup(interaction, {
                  content: `⛔ Watch limit reached (**${MAX_WATCHES_PER_USER}** per user). Remove some with \`/unwatch\` or \`/clearwatches\`.`,
                });
                return;
              }

              if (guildCount >= MAX_WATCHES_PER_GUILD) {
                await followup(interaction, {
                  content: `⛔ Server watch limit reached (**${MAX_WATCHES_PER_GUILD}**). Ask an admin to clean up old watches.`,
                });
                return;
              }

              const rec = await resolveItemFromD1(env, userItem);
              if (!rec?.id) {
                await followup(interaction, {
                  content: `❓ Couldn’t match **${userItem}** in the local dictionary.`,
                });
                return;
              }

              const canonicalName = rec.name;
              const now = Date.now();
              const itemKey = nameKey(canonicalName);

              // Upsert per user/item in guild
              const existing = await env.flea_bot_db
                .prepare(`SELECT id FROM watches WHERE guild_id=? AND user_id=? AND item_key=? LIMIT 1`)
                .bind(guildId, userId, itemKey)
                .first();

              if (existing?.id) {
                await env.flea_bot_db
                  .prepare(`UPDATE watches SET max_price=?, once=?, item_id=?, channel_id=?, item_name=? WHERE id=?`)
                  .bind(maxPrice, once ? 1 : 0, rec.id, channelId, canonicalName, existing.id)
                  .run();

                await followup(interaction, {
                  content: `♻️ Updated: **${canonicalName}** ≤ **${formatRUB(maxPrice)}**${once ? " (once)" : ""}`,
                });
                return;
              }

              await env.flea_bot_db
                .prepare(
                  `INSERT INTO watches (guild_id, channel_id, user_id, item_name, item_key, item_id, max_price, once, created_at, cooldown_until)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .bind(guildId, channelId, userId, canonicalName, itemKey, rec.id, maxPrice, once ? 1 : 0, now, 0)
                .run();

              await followup(interaction, {
                content: `✅ Watching **${canonicalName}** at **≤ ${formatRUB(maxPrice)}**${once ? " (once)" : ""}`,
              });
              return;
            }

            // /listwatches
            if (name === "listwatches") {
              const rows = await env.flea_bot_db
                .prepare(
                  `SELECT item_name, max_price, once
                   FROM watches
                   WHERE guild_id=? AND user_id=?
                   ORDER BY id DESC
                   LIMIT 25`
                )
                .bind(guildId, userId)
                .all();

              const results = rows?.results || [];
              const lines = results.length
                ? results
                    .map((r) => `• ${r.item_name} ≤ ${formatRUB(r.max_price)}${r.once ? " (once)" : ""}`)
                    .join("\n")
                : "No watches yet. Add one with `/watch`.";

              await followup(interaction, { content: `📌 **Your watches**\n${lines}` });
              return;
            }

            // /unwatch
            if (name === "unwatch") {
              const item = String(opt("item") || "").trim();
              if (!item) {
                await followup(interaction, { content: "⚠️ Usage: `/unwatch item:<name>`" });
                return;
              }

              // Use the same canonical-key logic
              const key = nameKey(item);

              const result = await env.flea_bot_db
                .prepare(`DELETE FROM watches WHERE guild_id=? AND user_id=? AND item_key LIKE ?`)
                .bind(guildId, userId, `%${key}%`)
                .run();

              const deleted = result?.meta?.changes || 0;
              await followup(interaction, {
                content: deleted ? `🧹 Removed watch for **${item}**.` : `ℹ️ No watch found for **${item}**.`,
              });
              return;
            }

            await followup(interaction, { content: `Unknown command: /${name}` });
          } catch (err) {
            console.error("Command error:", err);
            try {
              await followup(interaction, { content: "❌ Something went wrong. Check worker logs." });
            } catch {}
          }
        })()
      );

      return deferred;
    }

    return json({ type: 4, data: { content: "Unhandled interaction type." } });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          const now = Date.now();

          // Weekly refresh
          if (WEEKLY_REFRESH) {
            const last = Number((await metaGet(env, "items_last_sync_ms")) || 0);
            const WEEK = 7 * 24 * 60 * 60 * 1000;
            if (last && now - last > WEEK) {
              console.log("Weekly item refresh running...");
              try {
                await importAllItemsIntoD1(env);
                console.log("Weekly item refresh complete.");
              } catch (e) {
                console.log("Weekly item refresh failed:", e?.message || e);
              }
            }
          }

          const itemsCount = Number((await metaGet(env, "items_count")) || 0);
          if (!itemsCount) {
            console.log("Item dictionary empty. Skipping price checks.");
            return;
          }

          const rows = await env.flea_bot_db.prepare(`SELECT * FROM watches`).all();
          const watches = rows?.results || [];
          if (!watches.length) return;

          const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;

          for (const w of watches) {
            try {
              const cooldownUntil = Number(w.cooldown_until || 0);
              if (cooldownUntil && now < cooldownUntil) continue;

              const itemId = w.item_id;
              if (!itemId) continue;

              const market = await getMarketPriceRUB(itemId);
              if (!market.ok) continue;

              const price = Number(market.price || 0);
              const target = Number(w.max_price || 0);

              if (DEBUG_PRICES && market.raw) {
                console.log(
                  `[${w.item_name}] avg=${market.raw.avg} low=${market.raw.low} => using=${price}`
                );
              }

              if (price <= 0) continue;

              if (price <= target) {
                // Upgrade alert formatting (embed + mention)
                const embeds = [
                  buildPriceEmbed({
                    title: `🚨 ${w.item_name}`,
                    current: price,
                    target,
                    note: `Cooldown: ${COOLDOWN_MINUTES} min${Number(w.once) === 1 ? " • once-mode" : ""}`,
                  }),
                ];

                await sendChannelMessage(env, w.channel_id, {
                  content: `🚨 <@${w.user_id}>`,
                  embeds,
                });

                if (Number(w.once) === 1) {
                  await env.flea_bot_db.prepare(`DELETE FROM watches WHERE id=?`).bind(w.id).run();
                } else {
                  const nextCooldown = now + cooldownMs;
                  await env.flea_bot_db
                    .prepare(`UPDATE watches SET cooldown_until=? WHERE id=?`)
                    .bind(nextCooldown, w.id)
                    .run();
                }
              }
            } catch (inner) {
              console.error("Cron per-watch error:", inner);
            }
          }
        } catch (err) {
          console.error("Cron error:", err);
        }
      })()
    );
  },
};