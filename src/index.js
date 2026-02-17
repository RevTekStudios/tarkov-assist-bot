// src/index.js
import { verifyKey } from "discord-interactions";

const TARKOV_GQL = "https://api.tarkov.dev/graphql";

// ====== Tuning knobs ======
const COOLDOWN_MINUTES = 10;        // how long to wait after alerting (non-once watches)
const WEEKLY_REFRESH = true;        // keep weekly dictionary refresh
const DEBUG_PRICES = false;         // set true if you want cron to log price fields

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });

async function followup(interaction, content) {
  return fetch(
    `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }
  );
}

async function sendChannelMessage(env, channelId, content) {
  return fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
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
 * This lets us store canonical naming and avoid weird user-typed variants.
 */
async function resolveItemFromD1(env, itemName) {
  const key = nameKey(itemName);

  // Exact match
  const exact = await env.flea_bot_db
    .prepare(`SELECT id, name, short_name FROM items WHERE name_key=? LIMIT 1`)
    .bind(key)
    .first();
  if (exact?.id) return exact;

  // Loose match
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
 * We prioritize:
 *   1) avg24hPrice (stable)
 *   2) lastLowPrice (recent)
 * Optional fallback:
 *   3) sellFor vendor prices (NOT flea, but helps avoid "0" results)
 */
async function getMarketPriceRUB(itemId) {
  const q = `
    query ($id: ID!) {
      item(id: $id) {
        id
        name
        avg24hPrice
        lastLowPrice
        sellFor {
          price
          source
        }
      }
    }
  `;

  const d = await gql(q, { id: itemId });
  const it = d?.item;

  if (!it?.id) return { ok: false, name: null, price: 0, raw: null };

  const avg = typeof it.avg24hPrice === "number" ? it.avg24hPrice : 0;
  const low = typeof it.lastLowPrice === "number" ? it.lastLowPrice : 0;

  // Optional fallback: best vendor price (NOT flea) – last resort
  let vendor = 0;
  if (Array.isArray(it.sellFor) && it.sellFor.length) {
    vendor = it.sellFor.reduce((m, x) => (x?.price > m ? x.price : m), 0);
  }

  // Correct priority: avg24h first, then lastLow
  const price = (avg > 0 ? avg : 0) || (low > 0 ? low : 0) || 0;

  return {
    ok: true,
    name: it.name || null,
    price,
    raw: DEBUG_PRICES ? { avg, low, vendor } : null,
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

    async function autocompleteItems(env, userTyped) {
      const q = nameKey(userTyped);

      // If they typed nothing, return common-ish items (just some results)
      const pattern = q ? `%${q}%` : `%`;

      const rows = await env.flea_bot_db
        .prepare(
          `SELECT name, short_name
          FROM items
          WHERE name_key LIKE ?
          ORDER BY LENGTH(name_key) ASC
          LIMIT 25`
        )
        .bind(pattern)
        .all();

      const results = rows?.results || [];

      // Discord expects [{ name, value }]
      return results.map(r => ({
        name: r.short_name ? `${r.name} (${r.short_name})` : r.name,
        value: r.name // IMPORTANT: value must be what gets sent back into /watch
      }));
    }

    // Ping
    if (interaction.type === 1) return json({ type: 1 });

    // Autocomplete
    if (interaction.type === 4) {
      const itemsCount = Number((await metaGet(env, "items_count")) || 0);
      if (!itemsCount) {
        return json({ type: 8, data: { choices: [] } });
      }
      const focused = interaction.data?.options?.find(o => o.focused);
      const typed = focused?.value ? String(focused.value) : "";

      let choices = [];
      try {
        // Only autocomplete for the "item" field
        if (focused?.name === "item") {
          choices = await autocompleteItems(env, typed);
        }
      } catch (e) {
        console.error("Autocomplete error:", e);
        choices = [];
      }

      return json({
        type: 8, // AUTOCOMPLETE RESULT
        data: { choices }
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

      // Always defer to avoid 3s timeouts
      const deferred = json({ type: 5 });

      ctx.waitUntil(
        (async () => {
          try {
            if (!guildId || !channelId || !userId) {
              await followup(interaction, "⚠️ Missing guild/channel/user context.");
              return;
            }

            if (name === "help") {
              await followup(
                interaction,
                "🧠 **Tarkov Assist Bot**\n" +
                  "• `/watch item max_price [once]` — watch a flea price\n" +
                  "• `/listwatches` — show your watches\n" +
                  "• `/unwatch item` — remove a watch\n" +
                  "• `/syncitems` — (admin) refresh local item dictionary\n"
              );
              return;
            }

            // Admin-only: /syncitems
            if (name === "syncitems") {
              if (!isAdmin(env, userId)) {
                await followup(interaction, "⛔ This command is admin-only.");
                return;
              }

              await followup(interaction, "⏳ Syncing item dictionary from tarkov.dev…");
              const count = await importAllItemsIntoD1(env);
              await followup(interaction, `✅ Synced **${count.toLocaleString()}** items into D1.`);
              return;
            }

            // /watch
            if (name === "watch") {
              const userItem = String(opt("item") || "").trim();
              const maxPrice = Number(opt("max_price") || 0);
              const once = Boolean(opt("once") || false);

              if (!userItem || !Number.isFinite(maxPrice) || maxPrice < 1) {
                await followup(interaction, "⚠️ Usage: `/watch item:<name> max_price:<number>`");
                return;
              }

              const itemsCount = Number((await metaGet(env, "items_count")) || 0);
              if (!itemsCount) {
                await followup(
                  interaction,
                  "⚠️ Item dictionary is empty.\nRun `/syncitems` (admin) once to import all items."
                );
                return;
              }

              // Resolve canonical item record
              const rec = await resolveItemFromD1(env, userItem);
              if (!rec?.id) {
                await followup(
                  interaction,
                  `❓ Couldn’t match **${userItem}** in the local dictionary.\nTry a more exact name, or run \`/syncitems\` if it’s outdated.`
                );
                return;
              }

              const canonicalName = rec.name;
              const now = Date.now();

              // IMPORTANT: item_key should be based on canonical name for stable matching
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

                await followup(
                  interaction,
                  `♻️ Updated: **${canonicalName}** ≤ **${maxPrice.toLocaleString()} ₽**${once ? " (once)" : ""}`
                );
                return;
              }

              await env.flea_bot_db
                .prepare(
                  `INSERT INTO watches (guild_id, channel_id, user_id, item_name, item_key, item_id, max_price, once, created_at, cooldown_until)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .bind(guildId, channelId, userId, canonicalName, itemKey, rec.id, maxPrice, once ? 1 : 0, now, 0)
                .run();

              await followup(
                interaction,
                `✅ Watching **${canonicalName}** at **≤ ${maxPrice.toLocaleString()} ₽**${once ? " (once)" : ""}`
              );
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
                    .map(
                      (r) =>
                        `• ${r.item_name} ≤ ${Number(r.max_price).toLocaleString()} ₽${r.once ? " (once)" : ""}`
                    )
                    .join("\n")
                : "No watches yet. Add one with `/watch`.";

              await followup(interaction, `📌 **Your watches**\n${lines}`);
              return;
            }

            // /unwatch
            if (name === "unwatch") {
              const item = String(opt("item") || "").trim();
              if (!item) {
                await followup(interaction, "⚠️ Usage: `/unwatch item:<name>`");
                return;
              }

              // Match on canonical key logic
              const key = nameKey(item);

              const result = await env.flea_bot_db
                .prepare(`DELETE FROM watches WHERE guild_id=? AND user_id=? AND item_key LIKE ?`)
                .bind(guildId, userId, `%${key}%`)
                .run();

              const deleted = result?.meta?.changes || 0;
              await followup(
                interaction,
                deleted ? `🧹 Removed watch for **${item}**.` : `ℹ️ No watch found for **${item}**.`
              );
              return;
            }

            await followup(interaction, `Unknown command: /${name}`);
          } catch (err) {
            console.error("Command error:", err);
            try {
              await followup(interaction, "❌ Something went wrong. Check worker logs.");
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

          // Optional weekly refresh
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
                console.log(`[${w.item_name}] avg=${market.raw.avg} low=${market.raw.low} vendor=${market.raw.vendor} => using=${price}`);
              }

              // No valid flea price -> skip
              if (price <= 0) continue;

              if (price <= target) {
                await sendChannelMessage(
                  env,
                  w.channel_id,
                  `🚨 <@${w.user_id}> **${w.item_name}** is now **${price.toLocaleString()} ₽** (≤ ${target.toLocaleString()} ₽)`
                );

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