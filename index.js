const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  MessageFlags
} = require("discord.js");

const express = require("express");
const crypto = require("node:crypto");
const { Pool } = require("pg");

// RAILWAY VARIABLES
const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,
  VERIFIED_ROLE_ID,
  DATABASE_URL
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID ||
    !DISCORD_GUILD_ID || !VERIFIED_ROLE_ID ||
    !DATABASE_URL) {
  throw new Error("Missing Railway environment variables.");
}

// DATABASE
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

// DISCORD BOT

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

const HCAPTCHA_SITEKEY = process.env.HCAPTCHA_SITEKEY;
const HCAPTCHA_SECRET = process.env.HCAPTCHA_SECRET;
const APP_BASE_URL = process.env.APP_BASE_URL;

const browserVerifications = new Map();

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// CAPTCHA SETTINGS
const CAPTCHA_TIME = 2 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const captchaSessions = new Map();

const CAPTCHA_CATEGORIES = [
  "traffic lights",
  "bicycles",
  "dogs",
  "buses",
  "cats",
  "boats",
  "motorcycles",
  "cars"
];

// SLASH COMMANDS
const commands = [
  new SlashCommandBuilder()
    .setName("setupverify")
    .setDescription("Create the TLRP verification panel.")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild
    ),

  new SlashCommandBuilder()
    .setName("profile")
    .setDescription("View your linked Roblox account."),

  new SlashCommandBuilder()
    .setName("unlink")
    .setDescription("Unlink your Roblox account.")
];

// DATABASE SETUP
async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_links (
      discord_id TEXT PRIMARY KEY,
      roblox_id TEXT UNIQUE NOT NULL,
      roblox_username TEXT NOT NULL,
      verified_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// REGISTER COMMANDS
async function registerCommands() {
  const rest = new REST({ version: "10" })
    .setToken(DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(
      DISCORD_CLIENT_ID,
      DISCORD_GUILD_ID
    ),
    {
      body: commands.map(c => c.toJSON())
    }
  );

  console.log("TLRP commands registered.");
}

// EMBED CREATOR
function makeEmbed(title, description, color = 0x5865F2) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setFooter({ text: "TLRP Verification" });
}


app.get("/verify", (req, res) => {
  const id = req.query.id;

  if (!id || !browserVerifications.has(id)) {
    return res.status(400).send("Invalid or expired verification link.");
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>TLRP Verification</title>
      <script src="https://js.hcaptcha.com/1/api.js" async defer></script>
      <style>
        body {
          background: #202225;
          color: white;
          font-family: Arial;
          text-align: center;
          padding: 40px 10px;
        }
        .panel {
          background: #2f3136;
          padding: 25px;
          border-radius: 12px;
          max-width: 400px;
          margin: auto;
        }
        button {
          background: #5865f2;
          color: white;
          border: 0;
          padding: 12px 25px;
          border-radius: 6px;
          margin-top: 20px;
        }
      </style>
    </head>
    <body>
      <div class="panel">
        <h2>🛡️ TLRP Security Check</h2>
        <p>Complete the CAPTCHA to continue.</p>
        <form method="POST" action="/verify">
          <input type="hidden" name="id" value="${id.replace(/[^a-f0-9]/gi, "")}">
          <div class="h-captcha" data-sitekey="${HCAPTCHA_SITEKEY}"></div>
          <button type="submit">Verify</button>
        </form>
      </div>
    </body>
    </html>
  `);
});


app.post("/verify", async (req, res) => {
  const { id, "h-captcha-response": captchaResponse } = req.body;

  const session = browserVerifications.get(id);

  if (!session || Date.now() > session.expiresAt) {
    browserVerifications.delete(id);
    return res.status(400).send("Verification expired. Return to Discord and try again.");
  }

  if (!captchaResponse) {
    return res.status(400).send("Please complete the CAPTCHA.");
  }

  try {
    const params = new URLSearchParams();
    params.append("secret", HCAPTCHA_SECRET);
    params.append("response", captchaResponse);

    const response = await fetch(
      "https://api.hcaptcha.com/siteverify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params
      }
    );

    const result = await response.json();

    if (!result.success) {
      return res.status(403).send("CAPTCHA failed. Please try again.");
    }

    
// CAPTCHA passed - continue Roblox verification
browserVerifications.delete(id);

res.send(`
  <h2>✅ CAPTCHA passed!</h2>
  <p>Your Roblox account is now being checked.</p>
  <p>Return to Discord to see your result.</p>
`);

await completeVerification(
  session.interaction,
  session.username
);

return;


  } catch (error) {
    console.error("HCAPTCHA ERROR:", error);
    return res.status(500).send("Verification service temporarily unavailable.");
  }
});


// RANDOM HELPERS
function randomItem(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function shuffle(array) {
  const result = [...array];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

// ROBLOX USER LOOKUP
async function resolveRobloxUser(username) {
  const response = await fetch(
    "https://users.roblox.com/v1/usernames/users",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        usernames: [username],
        excludeBannedUsers: false
      })
    }
  );

  if (!response.ok) {
    throw new Error("Roblox username lookup failed.");
  }

  const data = await response.json();
  return data.data?.[0] || null;
}

// ROBLOX PROFILE
async function getRobloxProfile(id) {
  const response = await fetch(
    `https://users.roblox.com/v1/users/${id}`
  );

  if (!response.ok) {
    throw new Error("Roblox profile lookup failed.");
  }

  return response.json();
}

// GET CAPTCHA IMAGES


async function getCaptchaImages(category) {
  const searchTerms = {
    "traffic lights": "traffic light",
    bicycles: "bicycle",
    dogs: "dog",
    buses: "bus",
    cats: "cat",
    boats: "boat",
    motorcycles: "motorcycle",
    cars: "car"
  };

  const term = searchTerms[category];

  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: term,
    gsrnamespace: "6",
    gsrlimit: "50",
    prop: "imageinfo",
    iiprop: "url",
    iiurlwidth: "320",
    format: "json",
    origin: "*"
  });

  const response = await fetch(
    `https://commons.wikimedia.org/w/api.php?${params}`,
    {
      headers: {
        "User-Agent": "TLRPVerificationBot/1.0"
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Image source error: ${response.status}`);
  }

  const data = await response.json();

  return Object.values(data.query?.pages || {})
    .map(page => page.imageinfo?.[0]?.thumburl)
    .filter(url =>
      typeof url === "string" &&
      url.startsWith("https://upload.wikimedia.org/") &&
      !url.toLowerCase().endsWith(".svg")
    );
}


// CREATE RANDOM CAPTCHA
async function createCaptcha(username, userId) {
  const target = randomItem(CAPTCHA_CATEGORIES);

  const distractors = CAPTCHA_CATEGORIES.filter(
    category => category !== target
  );

  const distractor = randomItem(distractors);

  const [targetImages, otherImages] = await Promise.all([
    getCaptchaImages(target),
    getCaptchaImages(distractor)
  ]);

  if (targetImages.length < 4 || otherImages.length < 5) {
    throw new Error("Not enough CAPTCHA images found.");
  }

  const tiles = shuffle([
    ...shuffle(targetImages).slice(0, 4).map(url => ({
      url,
      correct: true
    })),
    ...shuffle(otherImages).slice(0, 5).map(url => ({
      url,
      correct: false
    }))
  ]);

  const challenge = {
    userId,
    username,
    target,
    tiles,
    selected: new Set(),
    attempts: 0,
    expiresAt: Date.now() + CAPTCHA_TIME
  };

  captchaSessions.set(userId, challenge);
  return challenge;
}

// CAPTCHA IMAGE EMBEDS
function buildCaptchaEmbeds(challenge) {
  return challenge.tiles.map((tile, index) => {
    const selected = challenge.selected.has(index);

    const embed = new EmbedBuilder()
      .setColor(selected ? 0x57F287 : 0x5865F2)
      .setTitle(`Tile ${index + 1}`)
      .setImage(tile.url);

    if (index === 0) {
      embed.setDescription(
        `Select all images containing **${challenge.target}**.`
      );
    }

    return embed;
  });
}

// CAPTCHA BUTTONS
function buildCaptchaButtons(challenge) {
  const rows = [];

  for (let r = 0; r < 2; r++) {
    const row = new ActionRowBuilder();

    for (let i = r * 5; i < Math.min(r * 5 + 5, 9); i++) {
      const selected = challenge.selected.has(i);

      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`tlrp_tile_${i}`)
          .setLabel(`${i + 1}${selected ? " ✓" : ""}`)
          .setStyle(
            selected
              ? ButtonStyle.Success
              : ButtonStyle.Secondary
          )
      );
    }

    rows.push(row);
  }

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("tlrp_submit")
        .setLabel("Submit CAPTCHA")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Primary)
    )
  );

  return rows;
}

// SHOW CAPTCHA
async function showCaptcha(interaction, challenge, message = "") {
  return interaction.editReply({
    content: message ||
      `🛡️ **TLRP Human Verification**\nSelect all images containing **${challenge.target}**.`,
    embeds: buildCaptchaEmbeds(challenge),
    components: buildCaptchaButtons(challenge)
  });
}

// VERIFICATION PANEL
async function setupPanel(interaction) {
  await interaction.deferReply({
    flags: MessageFlags.Ephemeral
  });

  try {
    const panel = makeEmbed(
      "🛡️ Welcome to TLRP!",
      [
        "To unlock all TLRP channels, verify your Roblox account.",
        "",
        "**How to verify:**",
        "1. Click Verify Account.",
        "2. Enter your Roblox username.",
        "3. Complete the image CAPTCHA.",
        "4. Pass the 7-day Roblox account age check.",
        "5. Receive your Verified role!",
        "",
        "Welcome to TLRP!"
      ].join("\n")
    );

    const button = new ButtonBuilder()
      .setCustomId("tlrp_verify")
      .setLabel("Verify Account")
      .setEmoji("🛡️")
      .setStyle(ButtonStyle.Success);

    await interaction.channel.send({
      embeds: [panel],
      components: [
        new ActionRowBuilder().addComponents(button)
      ]
    });

    await interaction.editReply("✅ Verification panel created!");

  } catch (error) {
    console.error("PANEL ERROR:", error);
    await interaction.editReply("❌ Could not create the panel.");
  }
}

// ROBLOX USERNAME POPUP
async function showModal(interaction) {
  const modal = new ModalBuilder()
    .setCustomId("tlrp_username_modal")
    .setTitle("TLRP Roblox Verification");

  const username = new TextInputBuilder()
    .setCustomId("roblox_username")
    .setLabel("Your Roblox username")
    .setPlaceholder("Enter your Roblox username")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(3)
    .setMaxLength(20);

  modal.addComponents(
    new ActionRowBuilder().addComponents(username)
  );

  await interaction.showModal(modal);
}

// START CAPTCHA

async function startVerification(interaction, username) {
  await interaction.deferReply({
    flags: MessageFlags.Ephemeral
  });

  try {
    const existing = await pool.query(
      "SELECT discord_id FROM account_links WHERE discord_id = $1",
      [interaction.user.id]
    );

    if (existing.rows.length) {
      return interaction.editReply(
        "You are already registered with TLRP Verification!"
      );
    }

    const id = crypto.randomBytes(24).toString("hex");

    browserVerifications.set(id, {
      discordId: interaction.user.id,
      username,
      interaction,
      expiresAt: Date.now() + 5 * 60 * 1000
    });

    await interaction.editReply({
      content:
        `🛡️ **TLRP Human Verification**\n\n` +
        `Complete your CAPTCHA here:\n` +
        `${APP_BASE_URL}/verify?id=${id}\n\n` +
        `You have 5 minutes to complete it.`
    });

  } catch (error) {
    console.error("START VERIFICATION ERROR:", error);

    return interaction.editReply(
      "❌ Could not start verification. Please try again."
    );
  }
}

// COMPLETE ROBLOX VERIFICATION
async function completeVerification(interaction, username) {
  try {
    const existing = await pool.query(
      "SELECT discord_id FROM account_links WHERE discord_id = $1",
      [interaction.user.id]
    );

    if (existing.rows.length) {
      return interaction.editReply(
        "You are already registered!"
      );
    }

    const user = await resolveRobloxUser(username);

    if (!user) {
      return interaction.editReply(
        "❌ Roblox account not found. Check your username."
      );
    }

    const profile = await getRobloxProfile(user.id);

    if (!profile.created) {
      return interaction.editReply(
        "❌ Could not check Roblox account age."
      );
    }

    const createdDate = new Date(profile.created);

    const ageDays = Math.floor(
      (Date.now() - createdDate.getTime()) / 86400000
    );

    if (!Number.isFinite(ageDays) || ageDays < 0) {
      return interaction.editReply(
        "❌ Could not verify account creation date."
      );
    }

    if (ageDays < 7) {
      return interaction.editReply(
        `❌ Your Roblox account is only ${ageDays} days old. TLRP requires at least 7 days.`
      );
    }

    const linked = await pool.query(
      "SELECT discord_id FROM account_links WHERE roblox_id = $1",
      [String(user.id)]
    );

    if (linked.rows.length) {
      return interaction.editReply(
        "❌ This Roblox account is already linked to another Discord account."
      );
    }

    const member = await interaction.guild.members.fetch(
      interaction.user.id
    );

    const saved = await pool.query(
      `INSERT INTO account_links
       (discord_id, roblox_id, roblox_username)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING discord_id`,
      [interaction.user.id, String(user.id), user.name]
    );

    if (!saved.rows.length) {
      return interaction.editReply(
        "❌ This account is already registered."
      );
    }

    try {
      await member.roles.add(
        VERIFIED_ROLE_ID,
        "TLRP CAPTCHA and Roblox age verification"
      );
    } catch (error) {
      await pool.query(
        "DELETE FROM account_links WHERE discord_id = $1",
        [interaction.user.id]
      );
      throw error;
    }

    return interaction.editReply({
      content: "",
      embeds: [
        makeEmbed(
          "✅ TLRP Verification Successful!",
          [
            `**Roblox:** ${user.name}`,
            `**Account age:** ${ageDays} days`,
            "",
            "CAPTCHA passed!",
            "Your Verified role has been assigned.",
            "Welcome to TLRP!"
          ].join("\n"),
          0x57F287
        )
      ],
      components: []
    });

  } catch (error) {
    console.error("VERIFICATION ERROR:", error);

    return interaction.editReply(
      "❌ Verification failed. Please contact staff."
    );
  }
}
// HANDLE CAPTCHA BUTTONS
async function handleCaptchaButton(interaction) {
  const challenge = captchaSessions.get(interaction.user.id);

  if (!challenge) {
    return interaction.reply({
      content: "Your CAPTCHA expired. Please start again.",
      flags: MessageFlags.Ephemeral
    });
  }

  if (Date.now() > challenge.expiresAt) {
    captchaSessions.delete(interaction.user.id);

    return interaction.update({
      content: "⏰ CAPTCHA expired. Please start again.",
      embeds: [],
      components: []
    });
  }

  // IMAGE SELECTION
  if (interaction.customId.startsWith("tlrp_tile_")) {
    const index = Number(
      interaction.customId.replace("tlrp_tile_", "")
    );

    if (!Number.isInteger(index) || index < 0 || index > 8) {
      return interaction.reply({
        content: "Invalid selection.",
        flags: MessageFlags.Ephemeral
      });
    }

    if (challenge.selected.has(index)) {
      challenge.selected.delete(index);
    } else {
      challenge.selected.add(index);
    }

    return interaction.update({
      content: `Select all images containing **${challenge.target}**.`,
      embeds: buildCaptchaEmbeds(challenge),
      components: buildCaptchaButtons(challenge)
    });
  }

  // SUBMIT CAPTCHA
  if (interaction.customId === "tlrp_submit") {
    const correct = challenge.tiles
      .map((tile, index) => tile.correct ? index : -1)
      .filter(index => index !== -1);

    const selected = [...challenge.selected].sort((a, b) => a - b);

    const expected = [...correct].sort((a, b) => a - b);

    const passed =
      selected.length === expected.length &&
      selected.every((value, index) => value === expected[index]);

    if (!passed) {
      challenge.attempts++;

      if (challenge.attempts >= MAX_ATTEMPTS) {
        captchaSessions.delete(interaction.user.id);

        return interaction.update({
          content: "❌ Too many attempts. Start verification again.",
          embeds: [],
          components: []
        });
      }

      try {
        const newChallenge = await createCaptcha(
          challenge.username,
          interaction.user.id
        );

        newChallenge.attempts = challenge.attempts;

        return interaction.update({
          content: `❌ Incorrect! Attempt ${challenge.attempts}/${MAX_ATTEMPTS}. Try again.`,
          embeds: buildCaptchaEmbeds(newChallenge),
          components: buildCaptchaButtons(newChallenge)
        });

      } catch (error) {
        console.error(error);
        captchaSessions.delete(interaction.user.id);

        return interaction.update({
          content: "Could not load another CAPTCHA. Try again later.",
          embeds: [],
          components: []
        });
      }
    }

    const username = challenge.username;

    captchaSessions.delete(interaction.user.id);

    await interaction.update({
      content: "✅ CAPTCHA passed! Checking your Roblox account...",
      embeds: [],
      components: []
    });

    return completeVerification(interaction, username);
  }
}

// PROFILE COMMAND
async function showProfile(interaction) {
  await interaction.deferReply({
    flags: MessageFlags.Ephemeral
  });

  const result = await pool.query(
    "SELECT * FROM account_links WHERE discord_id = $1",
    [interaction.user.id]
  );

  if (!result.rows.length) {
    return interaction.editReply(
      "You are not verified yet. Use Verify Account."
    );
  }

  const account = result.rows[0];

  return interaction.editReply({
    embeds: [
      makeEmbed(
        "Your TLRP Profile",
        `**Roblox:** ${account.roblox_username}\n**Profile:** https://www.roblox.com/users/${account.roblox_id}/profile`
      )
    ]
  });
}

// UNLINK COMMAND
async function unlinkAccount(interaction) {
  await interaction.deferReply({
    flags: MessageFlags.Ephemeral
  });

  const result = await pool.query(
    "DELETE FROM account_links WHERE discord_id = $1 RETURNING roblox_username",
    [interaction.user.id]
  );

  if (!result.rows.length) {
    return interaction.editReply(
      "You do not have a linked account."
    );
  }

  const member = await interaction.guild.members.fetch(
    interaction.user.id
  );

  await member.roles.remove(VERIFIED_ROLE_ID);

  return interaction.editReply(
    `Your Roblox account ${result.rows[0].roblox_username} has been unlinked.`
  );
}

// DISCORD INTERACTIONS
client.on("interactionCreate", async interaction => {
  try {
    if (interaction.guildId !== DISCORD_GUILD_ID) return;

    if (interaction.isButton()) {
      if (interaction.customId === "tlrp_verify") {
        return showModal(interaction);
      }

      if (
        interaction.customId.startsWith("tlrp_tile_") ||
        interaction.customId === "tlrp_submit"
      ) {
        return handleCaptchaButton(interaction);
      }
    }

    if (
      interaction.isModalSubmit() &&
      interaction.customId === "tlrp_username_modal"
    ) {
      const username = interaction.fields
        .getTextInputValue("roblox_username")
        .trim();

      return startVerification(interaction, username);
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "setupverify") {
      if (!interaction.memberPermissions?.has(
        PermissionFlagsBits.ManageGuild
      )) {
        return interaction.reply({
          content: "You need Manage Server permission.",
          flags: MessageFlags.Ephemeral
        });
      }

      return setupPanel(interaction);
    }

    if (interaction.commandName === "profile") {
      return showProfile(interaction);
    }

    if (interaction.commandName === "unlink") {
      return unlinkAccount(interaction);
    }

  } catch (error) {
    console.error("INTERACTION ERROR:", error);

    const response = {
      content: "An unexpected error occurred.",
      embeds: [],
      components: []
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(response).catch(() => {});
    } else {
      await interaction.reply({
        ...response,
        flags: MessageFlags.Ephemeral
      }).catch(() => {});
    }
  }
});

// BOT READY
client.once("clientReady", () => {
  console.log(`${client.user.tag} is online!`);
});

// START BOT

async function start() {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`TLRP CAPTCHA website running on port ${PORT}`);
  });

  await initializeDatabase();
  await registerCommands();
  await client.login(DISCORD_TOKEN);
}


start().catch(error => {
  console.error("STARTUP FAILED:", error);
  process.exit(1);
});

// SHUTDOWN
process.on("SIGTERM", async () => {
  client.destroy();
  await pool.end();
  process.exit(0);
});
