
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

// RAILWAY VARIABLES
const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,
  VERIFIED_ROLE_ID,
  DATABASE_URL
} = process.env;

if (
  !DISCORD_TOKEN ||
  !DISCORD_CLIENT_ID ||
  !DISCORD_GUILD_ID ||
  !VERIFIED_ROLE_ID ||
  !DATABASE_URL
) {
  throw new Error("One or more required Railway variables are missing.");
}

// DATABASE
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

// DISCORD BOT
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

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
      body: commands.map(command => command.toJSON())
    }
  );

  console.log("Slash commands registered.");
}

// EMBED CREATOR
function makeEmbed(title, description, color = 0x5865F2) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setFooter({ text: "TLRP Verification" });
}

// FIND ROBLOX USER
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
    throw new Error("Roblox username lookup failed: " + response.status);
  }

  const data = await response.json();
  return data.data?.[0] || null;
}

// GET ROBLOX PROFILE
async function getRobloxProfile(id) {
  const response = await fetch(
    `https://users.roblox.com/v1/users/${id}`
  );

  if (!response.ok) {
    throw new Error("Roblox profile lookup failed: " + response.status);
  }

  return response.json();
}

// CREATE VERIFICATION PANEL
async function setupPanel(interaction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const panel = makeEmbed(
      "🛡️ Welcome to TLRP!",
      [
        "To unlock access to all TLRP channels, verify your Roblox account.",
        "",
        "**How to get verified:**",
        "1. Click Verify Account.",
        "2. Enter your Roblox username.",
        "3. Our bot checks your Roblox account age.",
        "4. Receive your Verified role automatically!",
        "",
        "**Requirements:**",
        "• Your Roblox account must exist.",
        "• Your account must be at least 7 days old.",
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

    await interaction.editReply(
      "✅ TLRP verification panel created successfully!"
    );

  } catch (error) {
    console.error("SETUP PANEL ERROR:", error);

    await interaction.editReply(
      "❌ Could not create the panel. Check channel permissions."
    );
  }
}

// SHOW USERNAME POPUP
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

// VERIFY ROBLOX ACCOUNT AGE
async function startVerification(interaction, username) {
  await interaction.deferReply({ ephemeral: true });

  try {
    // Check whether Discord account is already linked
    const existing = await pool.query(
      "SELECT * FROM account_links WHERE discord_id = $1",
      [interaction.user.id]
    );

    if (existing.rows.length) {
      return interaction.editReply(
        "You already have a Roblox account linked. Use /profile to view it."
      );
    }

    // Look up Roblox username
    const user = await resolveRobloxUser(username);

    if (!user) {
      return interaction.editReply(
        "❌ Roblox account not found. Check your username."
      );
    }

    // Get account creation date
    const profile = await getRobloxProfile(user.id);

    if (!profile.created) {
      return interaction.editReply(
        "❌ Could not check your Roblox account age. Please try again."
      );
    }

    const createdDate = new Date(profile.created);

    const ageDays = Math.floor(
      (Date.now() - createdDate.getTime()) / 86400000
    );

    if (!Number.isFinite(ageDays) || ageDays < 0) {
      return interaction.editReply(
        "❌ Could not verify your Roblox account age."
      );
    }

    // Require at least 7 days
    if (ageDays < 7) {
      return interaction.editReply(
        `❌ Your Roblox account is only ${ageDays} days old.\n\nTLRP requires accounts to be at least 7 days old. Please come back later!`
      );
    }

    // Check whether Roblox account is already linked
    const linked = await pool.query(
      "SELECT discord_id FROM account_links WHERE roblox_id = $1",
      [String(user.id)]
    );

    if (linked.rows.length) {
      return interaction.editReply(
        "❌ This Roblox account is already linked to another Discord account."
      );
    }

    // Get Discord member
    const member = await interaction.guild.members.fetch(
      interaction.user.id
    );

    // Save account link
    const saved = await pool.query(
      `INSERT INTO account_links
       (discord_id, roblox_id, roblox_username)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING discord_id`,
      [
        interaction.user.id,
        String(user.id),
        user.name
      ]
    );

    if (!saved.rows.length) {
      return interaction.editReply(
        "❌ This Roblox or Discord account has already been linked."
      );
    }

    // Assign Verified role
    try {
      await member.roles.add(
        VERIFIED_ROLE_ID,
        "TLRP 7-day Roblox account age requirement"
      );
    } catch (roleError) {
      await pool.query(
        "DELETE FROM account_links WHERE discord_id = $1",
        [interaction.user.id]
      );

      throw roleError;
    }

    // Success message
    return interaction.editReply({
      embeds: [
        makeEmbed(
          "✅ TLRP Verification Successful!",
          [
            `**Roblox username:** ${user.name}`,
            `**Account age:** ${ageDays} days`,
            "",
            "You passed the 7-day account age requirement!",
            "",
            "Your Verified role has been assigned.",
            "Welcome to TLRP!"
          ].join("\n"),
          0x57F287
        )
      ]
    });

  } catch (error) {
    console.error("VERIFICATION ERROR:", error);

    return interaction.editReply(
      "❌ Verification failed. Please try again or contact staff."
    ).catch(console.error);
  }
}

// VIEW LINKED PROFILE
async function showProfile(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const result = await pool.query(
    "SELECT * FROM account_links WHERE discord_id = $1",
    [interaction.user.id]
  );

  if (!result.rows.length) {
    return interaction.editReply(
      "You are not verified yet. Click Verify Account to get started."
    );
  }

  const account = result.rows[0];

  return interaction.editReply({
    embeds: [
      makeEmbed(
        "Your TLRP Profile",
        [
          `**Roblox:** ${account.roblox_username}`,
          `**Profile:** https://www.roblox.com/users/${account.roblox_id}/profile`
        ].join("\n")
      )
    ]
  });
}

// UNLINK ACCOUNT
async function unlinkAccount(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const result = await pool.query(
    `DELETE FROM account_links
     WHERE discord_id = $1
     RETURNING roblox_username`,
    [interaction.user.id]
  );

  if (!result.rows.length) {
    return interaction.editReply(
      "You do not have a linked Roblox account."
    );
  }

  const member = await interaction.guild.members.fetch(
    interaction.user.id
  );

  await member.roles.remove(VERIFIED_ROLE_ID);

  return interaction.editReply(
    `Your Roblox account ${result.rows[0].roblox_username} has been unlinked and your Verified role removed.`
  );
}

// HANDLE DISCORD INTERACTIONS
client.on("interactionCreate", async interaction => {
  try {
    if (interaction.guildId !== DISCORD_GUILD_ID) return;

    // BUTTONS
    if (interaction.isButton()) {
      if (interaction.customId === "tlrp_verify") {
        return showModal(interaction);
      }
    }

    // USERNAME MODAL
    if (
      interaction.isModalSubmit() &&
      interaction.customId === "tlrp_username_modal"
    ) {
      const username = interaction.fields
        .getTextInputValue("roblox_username")
        .trim();

      return startVerification(interaction, username);
    }

    // SLASH COMMANDS
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
    console.error("INTERACTION ERROR:", error);

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

// BOT READY
client.once("ready", () => {
  console.log(`${client.user.tag} is online!`);
});

// START BOT
async function start() {
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
