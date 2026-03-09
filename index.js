const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, REST, Routes } = require('discord.js');
const express = require('express');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
require('dotenv').config();

// ─── إعداد Express API ───────────────────────────────────────
const app = express();
app.use(express.json());

// ─── إعداد Discord ───────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// ─── إعداد MySQL ─────────────────────────────────────────────
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'mta_server',
  waitForConnections: true,
  connectionLimit: 10,
};
let pool;

async function connectDB() {
  pool = mysql.createPool(dbConfig);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      discord_id VARCHAR(100),
      player_name VARCHAR(100),
      item_type VARCHAR(50),
      item_value VARCHAR(200),
      status ENUM('pending','approved','delivered','rejected') DEFAULT 'pending',
      redeem_code VARCHAR(50) UNIQUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      delivered_at TIMESTAMP NULL
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      discord_id VARCHAR(100) UNIQUE,
      player_name VARCHAR(100) UNIQUE,
      balance INT DEFAULT 0,
      vip_level INT DEFAULT 0,
      registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✅ MySQL متصل');
}

// ─── توليد كود Redeem ─────────────────────────────────────────
function generateRedeemCode() {
  return 'SYS-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

// ══════════════════════════════════════════════════════════════
//  API ROUTES - يستخدمها الموقع
// ══════════════════════════════════════════════════════════════

// التحقق من API Key
function checkApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ✅ [POST] الموقع يرسل طلب جديد
app.post('/api/order/new', checkApiKey, async (req, res) => {
  const { discord_id, player_name, item_type, item_value } = req.body;
  if (!discord_id || !player_name || !item_type || !item_value) {
    return res.status(400).json({ error: 'بيانات ناقصة' });
  }
  try {
    const [result] = await pool.execute(
      `INSERT INTO orders (discord_id, player_name, item_type, item_value, status) VALUES (?, ?, ?, ?, 'pending')`,
      [discord_id, player_name, item_type, item_value]
    );
    const orderId = result.insertId;

    // إشعار الأدمن في Discord
    const adminChannel = client.channels.cache.get(process.env.ADMIN_CHANNEL_ID);
    if (adminChannel) {
      const embed = new EmbedBuilder()
        .setTitle('🛒 طلب جديد')
        .setColor(0xFFA500)
        .addFields(
          { name: '🎮 اللاعب', value: player_name, inline: true },
          { name: '📦 العنصر', value: `${item_type}: ${item_value}`, inline: true },
          { name: '🆔 رقم الطلب', value: `#${orderId}`, inline: true }
        )
        .setFooter({ text: `Discord: ${discord_id}` })
        .setTimestamp();
      adminChannel.send({ embeds: [embed] });
    }

    res.json({ success: true, order_id: orderId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في السيرفر' });
  }
});

// ✅ [POST] الموقع يضغط زر التسليم - يولد كود ويرسله للاعب
app.post('/api/order/deliver', checkApiKey, async (req, res) => {
  const { order_id } = req.body;
  try {
    const [rows] = await pool.execute(`SELECT * FROM orders WHERE id = ?`, [order_id]);
    if (rows.length === 0) return res.status(404).json({ error: 'الطلب مو موجود' });
    const order = rows[0];
    if (order.status === 'delivered') return res.status(400).json({ error: 'الطلب تم تسليمه مسبقاً' });

    const code = generateRedeemCode();
    await pool.execute(
      `UPDATE orders SET status='approved', redeem_code=? WHERE id=?`,
      [code, order_id]
    );

    // إرسال الكود للاعب في Discord DM
    try {
      const user = await client.users.fetch(order.discord_id);
      const embed = new EmbedBuilder()
        .setTitle('🎁 طلبك جاهز!')
        .setColor(0x00FF7F)
        .setDescription(`استخدم الأمر التالي في السيرفر لاستلام طلبك:`)
        .addFields(
          { name: '📦 العنصر', value: `${order.item_type}: ${order.item_value}` },
          { name: '🔑 كود الاستلام', value: `/redeem ${code}` }
        )
        .setFooter({ text: 'الكود يستخدم مرة واحدة فقط' })
        .setTimestamp();
      await user.send({ embeds: [embed] });
    } catch (dmErr) {
      console.warn('⚠️ ما قدر يرسل DM:', dmErr.message);
    }

    res.json({ success: true, code });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في السيرفر' });
  }
});

// ✅ [GET] MTA يطلب تحقق من كود Redeem
app.get('/api/redeem/verify', checkApiKey, async (req, res) => {
  const { code, player_name } = req.query;
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM orders WHERE redeem_code = ? AND player_name = ? AND status = 'approved'`,
      [code, player_name]
    );
    if (rows.length === 0) {
      return res.json({ valid: false, reason: 'الكود غلط أو مستخدم أو اسم اللاعب مو صح' });
    }
    const order = rows[0];
    await pool.execute(
      `UPDATE orders SET status='delivered', delivered_at=NOW() WHERE id=?`,
      [order.id]
    );
    res.json({
      valid: true,
      item_type: order.item_type,
      item_value: order.item_value,
      player_name: order.player_name
    });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في السيرفر' });
  }
});

// ✅ [GET] جلب معلومات حساب
app.get('/api/account/:player_name', checkApiKey, async (req, res) => {
  const { player_name } = req.params;
  try {
    const [rows] = await pool.execute(`SELECT * FROM accounts WHERE player_name = ?`, [player_name]);
    if (rows.length === 0) return res.json({ found: false });
    res.json({ found: true, account: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في السيرفر' });
  }
});

// ✅ [GET] جلب طلبات لاعب معين
app.get('/api/orders/:player_name', checkApiKey, async (req, res) => {
  const { player_name } = req.params;
  try {
    const [rows] = await pool.execute(
      `SELECT id, item_type, item_value, status, created_at FROM orders WHERE player_name = ? ORDER BY created_at DESC LIMIT 20`,
      [player_name]
    );
    res.json({ orders: rows });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في السيرفر' });
  }
});

// ══════════════════════════════════════════════════════════════
//  DISCORD SLASH COMMANDS
// ══════════════════════════════════════════════════════════════

client.once('ready', async () => {
  console.log(`✅ البوت شغال: ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName('account')
      .setDescription('عرض تفاصيل حساب لاعب')
      .addStringOption(opt =>
        opt.setName('player').setDescription('اسم اللاعب').setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('orders')
      .setDescription('عرض طلبات لاعب')
      .addStringOption(opt =>
        opt.setName('player').setDescription('اسم اللاعب').setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('approve')
      .setDescription('الموافقة على طلب')
      .addIntegerOption(opt =>
        opt.setName('order_id').setDescription('رقم الطلب').setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('reject')
      .setDescription('رفض طلب')
      .addIntegerOption(opt =>
        opt.setName('order_id').setDescription('رقم الطلب').setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('sysinfo')
      .setDescription('معلومات عن النظام'),
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
  console.log('✅ Slash Commands مسجلة');
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ─── /account ────────────────────────────────────────────
  if (interaction.commandName === 'account') {
    const player = interaction.options.getString('player');
    const [rows] = await pool.execute(`SELECT * FROM accounts WHERE player_name = ?`, [player]);
    if (rows.length === 0) {
      return interaction.reply({ content: `❌ ما لقيت حساب باسم **${player}**`, ephemeral: true });
    }
    const acc = rows[0];
    const embed = new EmbedBuilder()
      .setTitle(`👤 حساب: ${acc.player_name}`)
      .setColor(0x5865F2)
      .addFields(
        { name: '🎮 اسم اللاعب', value: acc.player_name, inline: true },
        { name: '💰 الرصيد', value: `$${acc.balance}`, inline: true },
        { name: '⭐ VIP', value: `المستوى ${acc.vip_level}`, inline: true },
        { name: '📅 تاريخ التسجيل', value: new Date(acc.registered_at).toLocaleDateString('ar') }
      );
    interaction.reply({ embeds: [embed] });
  }

  // ─── /orders ─────────────────────────────────────────────
  if (interaction.commandName === 'orders') {
    const player = interaction.options.getString('player');
    const [rows] = await pool.execute(
      `SELECT * FROM orders WHERE player_name = ? ORDER BY created_at DESC LIMIT 10`,
      [player]
    );
    if (rows.length === 0) {
      return interaction.reply({ content: `❌ مافي طلبات للاعب **${player}**`, ephemeral: true });
    }
    const statusEmoji = { pending: '⏳', approved: '✅', delivered: '📦', rejected: '❌' };
    const embed = new EmbedBuilder()
      .setTitle(`📋 طلبات: ${player}`)
      .setColor(0x5865F2)
      .setDescription(rows.map(r =>
        `**#${r.id}** ${statusEmoji[r.status]} ${r.item_type}: ${r.item_value}`
      ).join('\n'));
    interaction.reply({ embeds: [embed] });
  }

  // ─── /approve ────────────────────────────────────────────
  if (interaction.commandName === 'approve') {
    const orderId = interaction.options.getInteger('order_id');
    const [rows] = await pool.execute(`SELECT * FROM orders WHERE id = ?`, [orderId]);
    if (rows.length === 0) return interaction.reply({ content: '❌ الطلب مو موجود', ephemeral: true });
    const order = rows[0];
    const code = generateRedeemCode();
    await pool.execute(`UPDATE orders SET status='approved', redeem_code=? WHERE id=?`, [code, orderId]);

    try {
      const user = await client.users.fetch(order.discord_id);
      const embed = new EmbedBuilder()
        .setTitle('🎁 طلبك تمت الموافقة عليه!')
        .setColor(0x00FF7F)
        .addFields(
          { name: '📦 العنصر', value: `${order.item_type}: ${order.item_value}` },
          { name: '🔑 كود الاستلام', value: `/redeem ${code}` }
        )
        .setFooter({ text: 'استخدم الكود في السيرفر لاستلام طلبك' });
      await user.send({ embeds: [embed] });
    } catch {}

    interaction.reply({ content: `✅ تمت الموافقة على الطلب **#${orderId}** وتم إرسال الكود للاعب`, ephemeral: true });
  }

  // ─── /reject ─────────────────────────────────────────────
  if (interaction.commandName === 'reject') {
    const orderId = interaction.options.getInteger('order_id');
    await pool.execute(`UPDATE orders SET status='rejected' WHERE id=?`, [orderId]);
    interaction.reply({ content: `❌ تم رفض الطلب **#${orderId}**`, ephemeral: true });
  }

  // ─── /sysinfo ────────────────────────────────────────────
  if (interaction.commandName === 'sysinfo') {
    const [orderStats] = await pool.execute(`
      SELECT 
        COUNT(*) as total,
        SUM(status='pending') as pending,
        SUM(status='approved') as approved,
        SUM(status='delivered') as delivered
      FROM orders
    `);
    const stats = orderStats[0];
    const embed = new EmbedBuilder()
      .setTitle('⚙️ System Bot - معلومات النظام')
      .setColor(0x5865F2)
      .addFields(
        { name: '📊 إجمالي الطلبات', value: `${stats.total}`, inline: true },
        { name: '⏳ قيد الانتظار', value: `${stats.pending}`, inline: true },
        { name: '✅ موافق عليها', value: `${stats.approved}`, inline: true },
        { name: '📦 تم التسليم', value: `${stats.delivered}`, inline: true },
        { name: '🟢 حالة API', value: 'شغال', inline: true },
        { name: '🎮 MTA Bridge', value: 'متصل', inline: true }
      )
      .setTimestamp();
    interaction.reply({ embeds: [embed] });
  }
});

// ══════════════════════════════════════════════════════════════
//  التشغيل
// ══════════════════════════════════════════════════════════════
async function main() {
  await connectDB();
  app.listen(process.env.PORT || 3000, () => {
    console.log(`✅ API شغال على البورت ${process.env.PORT || 3000}`);
  });
  await client.login(process.env.DISCORD_TOKEN);
}

main().catch(console.error);