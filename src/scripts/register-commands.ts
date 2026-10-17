import { registerCommands } from '../commands.js';

if (!process.env.BOT_TOKEN_1 || !process.env.GUILD_ID) throw new Error('Missing BOT_TOKEN_1 or GUILD_ID');
try { await registerCommands(process.env.BOT_TOKEN_1, process.env.GUILD_ID); console.log('Guild commands registered on Bot 1.'); }
catch { console.error('Command registration failed. Check Bot 1 token, guild ID and application invite.'); process.exitCode = 1; }
