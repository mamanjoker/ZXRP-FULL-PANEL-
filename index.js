require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs-extra');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const { nanoid } = require('nanoid');
const { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField } = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// --- db (lowdb)
const dbFile = path.join(__dirname, 'db.json');
const adapter = new JSONFile(dbFile);
const db = new Low(adapter);

(async ()=>{ await db.read(); db.data ||= { applications: [], settings: { prefix: '!' }, tickets: [], welcome: { enabled:false, channel:null, message:'' } }; await db.write(); })();

// --- Discord bot (for logs, welcome, moderation)
const bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel] });
const BOT_TOKEN = process.env.BOT_TOKEN || 'BOT_TOKEN_PLACEHOLDER';

bot.on('ready', ()=> console.log('Bot ready: '+(bot.user?bot.user.tag:'unknown')));
// auto-role on join if enabled in settings
bot.on('guildMemberAdd', async member => {
  try {
    await db.read();
    const ar = db.data.settings?.autoRoleName;
    if (ar) {
      const role = member.guild.roles.cache.find(r => r.name === ar);
      if (role) await member.roles.add(role).catch(()=>null);
    }
    // welcome
    const welcomeCfg = db.data.welcome || {};
    if (welcomeCfg.enabled && welcomeCfg.channel) {
      const ch = await member.guild.channels.fetch(welcomeCfg.channel).catch(()=>null);
      if (ch && ch.isTextBased()) ch.send(welcomeCfg.message.replace('{user}', `<@${member.id}>`)).catch(()=>null);
    }
  } catch(e){ console.error('guildMemberAdd err', e); }
});

// simple moderation commands via chat (ban/kick/mute) - only prefix commands processed
bot.on('messageCreate', async msg => {
  if (!msg.guild || msg.author.bot) return;
  await db.read();
  const prefix = db.data.settings?.prefix || '!';
  if (!msg.content.startsWith(prefix)) return;
  const args = msg.content.slice(prefix.length).trim().split(/\s+/);
  const cmd = args.shift().toLowerCase();
  if (cmd === 'createticket') {
    const id = nanoid(6);
    const title = args.join(' ') || 'No title';
    db.data.tickets.push({ id, title, user: msg.author.tag, userId: msg.author.id, status: 'Open', createdAt: new Date().toISOString() });
    await db.write();
    msg.reply(`Ticket created: ${id}`);
    const logId = process.env.LOG_CHANNEL_ID;
    if (logId) {
      const ch = await msg.guild.channels.fetch(logId).catch(()=>null);
      if (ch && ch.isTextBased()) ch.send(`New ticket ${id} by <@${msg.author.id}> — ${title}`).catch(()=>null);
    }
  }
  if (cmd === 'ban') {
    if (!msg.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return msg.reply('No permission');
    const user = msg.mentions.members.first();
    if (!user) return msg.reply('Mention user');
    user.ban({reason: args.slice(1).join(' ')||'No reason'}).then(()=>msg.reply('Banned')).catch(()=>msg.reply('Failed'));
  }
  if (cmd === 'kick') {
    if (!msg.member.permissions.has(PermissionsBitField.Flags.KickMembers)) return msg.reply('No permission');
    const user = msg.mentions.members.first();
    if (!user) return msg.reply('Mention user');
    user.kick(args.slice(1).join(' ')||'No reason').then(()=>msg.reply('Kicked')).catch(()=>msg.reply('Failed'));
  }
});

bot.login(BOT_TOKEN).catch(()=>console.warn('Bot token not set or invalid'));

// --- Passport Discord (dashboard login)
passport.serializeUser((u,done)=>done(null,u));
passport.deserializeUser((u,done)=>done(null,u));
passport.use(new DiscordStrategy({
  clientID: process.env.CLIENT_ID || 'CLIENT_ID_PLACEHOLDER',
  clientSecret: process.env.CLIENT_SECRET || 'CLIENT_SECRET_PLACEHOLDER',
  callbackURL: process.env.CALLBACK_URL || (BASE_URL + '/auth/callback'),
  scope: ['identify','guilds']
}, (accessToken, refreshToken, profile, done) => done(null, profile)));

app.set('view engine','ejs');
app.set('views', path.join(__dirname,'views'));
app.use(express.static(path.join(__dirname,'public')));
app.use(bodyParser.urlencoded({ extended:true }));
app.use(session({ secret: process.env.SESSION_SECRET || 'zxrp_secret', resave:false, saveUninitialized:false }));
app.use(passport.initialize());
app.use(passport.session());

function ensureAuth(req,res,next){ if (req.isAuthenticated()) return next(); res.redirect('/'); }

// --- Routes
app.get('/', (req,res)=>res.render('index',{ user: req.user }));
app.get('/login', passport.authenticate('discord'));
app.get('/auth/callback', passport.authenticate('discord',{ failureRedirect:'/' }),(req,res)=>res.redirect('/dashboard'));
app.get('/logout', (req,res)=>{ req.logout(()=>{}); res.redirect('/'); });

app.get('/dashboard', ensureAuth, async (req,res)=>{ await db.read(); res.render('dashboard',{ user: req.user, apps: db.data.applications, settings: db.data.settings, tickets: db.data.tickets, welcome: db.data.welcome }); });

// settings page (prefix, auto role toggles)
app.get('/settings', ensureAuth, async (req,res)=>{ await db.read(); res.render('settings',{ settings: db.data.settings }); });
app.post('/settings', ensureAuth, async (req,res)=>{
  await db.read();
  const { prefix, autoRoleName } = req.body;
  db.data.settings = db.data.settings || {};
  db.data.settings.prefix = prefix || '!';
  db.data.settings.autoRoleName = autoRoleName || '';
  await db.write();
  res.redirect('/settings');
});

// welcome config
app.post('/welcome', ensureAuth, async (req,res)=>{
  await db.read();
  const { enabled, channel, message } = req.body;
  db.data.welcome = { enabled: enabled === 'on', channel: channel || null, message: message || '' };
  await db.write();
  res.redirect('/settings');
});

// tickets & interviews management
app.post('/ticket/create', ensureAuth, async (req,res)=>{ await db.read(); const { title, description } = req.body; const id = nanoid(6); db.data.tickets.push({ id, title, description, status:'Open', createdAt: new Date().toISOString() }); await db.write(); res.redirect('/dashboard'); });
app.post('/ticket/close/:id', ensureAuth, async (req,res)=>{ await db.read(); const t = db.data.tickets.find(x=>x.id===req.params.id); if(t) t.status='Closed'; await db.write(); res.redirect('/dashboard'); });

app.get('/apply', (req,res)=>res.render('apply'));
app.post('/apply', async (req,res)=>{
  const { name, discordTag, about } = req.body;
  await db.read();
  const id = nanoid(8);
  const application = { id, name, discordTag, about, status:'Pending', createdAt: new Date().toISOString() };
  db.data.applications.push(application);
  await db.write();
  // send log
  try{
    const chId = process.env.LOG_CHANNEL_ID;
    if (chId && bot.isReady()){
      const ch = await bot.channels.fetch(chId).catch(()=>null);
      if (ch && ch.isTextBased()){
        const embed = new EmbedBuilder().setTitle('New Application').addFields({ name:'Name', value: application.name || 'N/A', inline:true }, { name:'ID', value: application.id, inline:true }).setDescription(application.about || 'No info').setTimestamp(new Date());
        ch.send({ embeds: [embed] }).catch(()=>null);
      }
    }
  }catch(e){ console.error('log error', e); }
  res.render('apply_submitted',{ application });
});

app.get('/applications/:id', ensureAuth, async (req,res)=>{ await db.read(); const item = db.data.applications.find(a=>a.id===req.params.id); if(!item) return res.status(404).send('Not found'); res.render('application_detail',{ application: item }); });

app.post('/applications/:id/decision', ensureAuth, async (req,res)=>{ const id = req.params.id; const { decision } = req.body; await db.read(); const item = db.data.applications.find(a=>a.id===id); if(!item) return res.status(404).send('Not found'); item.status = decision; item.decisionBy = req.user.username || req.user.id; item.decisionAt = new Date().toISOString(); await db.write(); // log to channel try{ const chId = process.env.LOG_CHANNEL_ID; if (chId && bot.isReady()){ const ch = await bot.channels.fetch(chId).catch(()=>null); if (ch && ch.isTextBased()){ const embed = new EmbedBuilder().setTitle(`Application ${decision}`).addFields({ name:'Applicant', value: item.name || item.discordTag || 'N/A', inline:true }, { name:'Decision By', value: item.decisionBy, inline:true }).setDescription(item.about || 'No details').setTimestamp(new Date()); ch.send({ embeds: [embed] }).catch(()=>null); } } }catch(e){ console.error('decision log error', e); } res.redirect('/applications/'+id); });

app.get('/api/application/:id', async (req,res)=>{ await db.read(); const item = db.data.applications.find(a=>a.id===req.params.id); if(!item) return res.status(404).json({ error:'Not found' }); res.json({ id: item.id, status: item.status, decisionBy: item.decisionBy, decisionAt: item.decisionAt }); });

app.listen(PORT, ()=>console.log('Dashboard running on port '+PORT));
