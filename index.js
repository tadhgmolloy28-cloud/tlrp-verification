
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
  PermissionFlagsBits
} = require("discord.js");

const { Pool } = require("pg");
const crypto = require("crypto");

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,
  VERIFIED_ROLE_ID,
  DATABASE_URL
} = process.env;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

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

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_links (
      discord_id TEXT PRIMARY KEY,
      roblox_id TEXT UNIQUE NOT NULL,
      roblox_username TEXT NOT NULL,
      verified_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_verifications (
      discord_id TEXT PRIMARY KEY,
      roblox_id TEXT NOT NULL,
      roblox_username TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
}

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
}

function makeEmbed(title, description, color = 0x5865F2) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setFooter({ text: "TLRP Verification" });
}

async function resolveRobloxUser(username) {
  const response = await fetch(
    "https://users.roblox.com/v1/usernames/users",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        usernames: [username],
        excludeBannedUsers: false
      })
    }
  );

  if (!response.ok) throw new Error("Roblox API error");

  const data = await response.json();
  return data.data?.[0] || null;
}

async function getRobloxProfile(id) {
  const response = await fetch(
    `https://users.roblox.com/v1/users/${id}`
  );

  if (!response.ok) throw new Error("Roblox profile error");

  return response.json();
}

// CREATE PUBLIC VERIFICATION PANEL

async function setupPanel(interaction) {
  const panel = makeEmbed(
    "🛡️ Welcome to TLRP!",
    [
      "To unlock access to all TLRP channels,",
      "you must verify your Roblox account.",
      "",
      "**How to verify:**",
      "1. Click Verify Account.",
      "2. Enter your Roblox username.",
      "3. Copy your unique verification code.",
      "4. Put it in your Roblox About description.",
      "5. Press Confirm Verification.",
      "",
      "You will automatically receive the Verified role!",
      "",
      "**Click below to get started.**"
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

  await interaction.reply({
    content: "Verification panel created!",
    ephemeral: true
  });
}

// SHOW ROBLOX USERNAME POPUP

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

// START VERIFICATION

async function startVerification(interaction, username) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const existing = await pool.query(
      "SELECT * FROM account_links WHERE discord_id = $1",
      [interaction.user.id]
    );

    if (existing.rows.length) {
      return interaction.editReply(
        "You are already verified! Use /profile to view your account."
      );
    }

    const user = await resolveRobloxUser(username);

    if (!user) {
      return interaction.editReply(
        "Roblox account not found. Check your username."
      );
    }

    const linked = await pool.query(
      "SELECT discord_id FROM account_links WHERE roblox_id = $1",
      [String(user.id)]
    );

    if (linked.rows.length) {
      return interaction.editReply(
        "This Roblox account is already linked to another Discord account."
      );
    }

    const code =
      "TLRP-" +
      crypto.randomBytes(4).toString("hex").toUpperCase();

    await pool.query(
      `INSERT INTO pending_verifications
      (discord_id, roblox_id, roblox_username, code, expires_at)
      VALUES ($1, $2, $3, $4, NOW() + INTERVAL '15 minutes')
      ON CONFLICT (discord_id)
      DO UPDATE SET
        roblox_id = EXCLUDED.roblox_id,
        roblox_username = EXCLUDED.roblox_username,
        code = EXCLUDED.code,
        expires_at = EXCLUDED.expires_at`,
      [interaction.user.id, String(user.id), user.name, code]
    );

    const embed = makeEmbed(
      "Roblox verification",
      [
        `**Roblox account:** ${user.name}`,
        "",
        "**Your unique code:**",
        `\`${code}\``,
        "",
        "1. Open your Roblox profile.",
        "2. Edit your About description.",
        "3. Paste your code.",
        "4. Save your profile.",
        "5. Return here and press Confirm Verification.",
        "",
        "Your code expires in 15 minutes."
      ].join("\n")
    );

    const button = new ButtonBuilder()
      .setCustomId("tlrp_confirm")
      .setLabel("Confirm Verification")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Primary);

    await interaction.editReply({
      embeds: [embed],
      components: [
        new ActionRowBuilder().addComponents(button)
      ]
    });

  } catch (error) {
    console.error(error);
    await interaction.editReply(
      "Something went wrong. Please try again later."
    );
  }
}

// CONFIRM OWNERSHIP AND ASSIGN ROLE

async function confirmVerification(interaction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const result = await pool.query(
      "SELECT * FROM pending_verifications WHERE discord_id = $1",
      [interaction.user.id]
    );

    if (!result.rows.length) {
      return interaction.editReply(
        "No pending verification. Click Verify Account first."
      );
    }

    const pending = result.rows[0];

    if (new Date(pending.expires_at).getTime() < Date.now()) {
      await pool.query(
        "DELETE FROM pending_verifications WHERE discord_id = $1",
        [interaction.user.id]
      );

      return interaction.editReply(
        "Your code expired. Please start again."
      );
    }

    const profile = await getRobloxProfile(pending.roblox_id);

    if (!profile.description?.includes(pending.code)) {
      return interaction.editReply(
        "Code not found in your Roblox About description. Save it and try again."
      );
    }

    const saved = await pool.query(
      `INSERT INTO account_links
      (discord_id, roblox_id, roblox_username)
      VALUES ($1, $2, $3)
      ON CONFLICT DO NOTHING
      RETURNING discord_id`,
      [
        interaction.user.id,
        String(pending.roblox_id),
        pending.roblox_username
      ]
    );

    if (!saved.rows.length) {
      return interaction.editReply(
        "This Roblox account or Discord account is already linked."
      );
    }

    const member = await interaction.guild.members.fetch(
      interaction.user.id
    );

    await member.roles.add(
      VERIFIED_ROLE_ID,
      "TLRP Roblox verification completed"
    );

    await pool.query(
      "DELETE FROM pending_verifications WHERE discord_id = $1",
      [interaction.user.id]
    );

    return interaction.editReply({
      embeds: [
        makeEmbed(
          "Verification successful!",
          `Your account **${pending.roblox_username}** is verified. You now have access to TLRP!`,
          0x57F287
        )
      ],
      components: []
    });

  } catch (error) {
    console.error(error);
    await interaction.editReply(
      "Verification failed. Please contact an administrator."
    );
  }
}

// PROFILE

async function showProfile(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const result = await pool.query(
    "SELECT * FROM account_links WHERE discord_id = $1",
    [interaction.user.id]
  );

  if (!result.rows.length) {
    return interaction.editReply(
      "You are not verified yet. Use the Verify Account button."
    );
  }

  const account = result.rows[0];

  return interaction.editReply({
    embeds: [
      makeEmbed(
        "Your TLRP profile",
        `**Roblox:** ${account.roblox_username}\n**Profile:** https://www.roblox.com/users/${account.roblox_id}/profile`
      )
    ]
  });
}

// UNLINK

async function unlinkAccount(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const result = await pool.query(
    "DELETE FROM account_links WHERE discord_id = $1 RETURNING roblox_username",
    [interaction.user.id]
  );

  if (!result.rows.length) {
    return interaction.editReply("You do not have a linked account.");
  }

  await pool.query(
    "DELETE FROM pending_verifications WHERE discord_id = $1",
    [interaction.user.id]
  );

  const member = await interaction.guild.members.fetch(
    interaction.user.id
  );

  await member.roles.remove(VERIFIED_ROLE_ID).catch(console.error);

  return interaction.editReply(
    `Your Roblox account ${result.rows[0].roblox_username} has been unlinked.`
  );
}

// HANDLE INTERACTIONS

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.guildId !== DISCORD_GUILD_ID) return;

    if (interaction.isButton()) {
      if (interaction.customId === "tlrp_verify") {
        return showModal(interaction);
      }

      if (interaction.customId === "tlrp_confirm") {
        return confirmVerification(interaction);
      }
    }

    if (interaction.isModalSubmit() &&
        interaction.customId === "tlrp_username_modal") {
      const username = interaction.fields
        .getTextInputValue("roblox_username").trim();

      return startVerification(interaction, username);
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "setupverify") {
      if (!interaction.memberPermissions?.has(
        PermissionFlagsBits.ManageGuild
      )) {
        return interaction.reply({
          content: "You need Manage Server permission.",
          ephemeral: true
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
    console.error(error);

    const response = {
      content: "An unexpected error occurred. Please try again.",
      embeds: [],
      components: []
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(response).catch(() => {});
    } else {
      await interaction.reply({
        ...response,
        ephemeral: true
      }).catch(() => {});
    }
  }
});

client.once("ready", () => {
  console.log(`${client.user.tag} is online!`);
});

async function start() {
  await initializeDatabase();
  await registerCommands();
  await client.login(DISCORD_TOKEN);
}

start().catch(error => {
  console.error("Startup failed:", error);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  client.destroy();
  await pool.end();
  process.exit(0);
});
