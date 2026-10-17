import { MessageFlags, PermissionFlagsBits, REST, Routes, SlashCommandBuilder,
  type ChatInputCommandInteraction } from 'discord.js';
import type { Config } from './config.js';
import type { LeaderService } from './leaders.js';
import { isTeam, TEAMS, UserError } from './types.js';

const teamChoices = TEAMS.map(value => ({ name: `Team ${value}`, value }));
export const commandDefinitions = [
  new SlashCommandBuilder().setName('leader').setDescription('Quản lý leader CrossTalk')
    .addSubcommand(sub => sub.setName('set').setDescription('Thêm hoặc thay leader')
      .addIntegerOption(opt => opt.setName('team').setDescription('Team').setRequired(true).addChoices(...teamChoices))
      .addUserOption(opt => opt.setName('user').setDescription('Leader mới').setRequired(true)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Gỡ leader')
      .addIntegerOption(opt => opt.setName('team').setDescription('Team').setRequired(true).addChoices(...teamChoices)))
    .addSubcommand(sub => sub.setName('list').setDescription('Xem leader của ba team'))
    .addSubcommand(sub => sub.setName('show').setDescription('Xem leader của một team')
      .addIntegerOption(opt => opt.setName('team').setDescription('Team').setRequired(true).addChoices(...teamChoices))),
  new SlashCommandBuilder().setName('status').setDescription('Xem trạng thái CrossTalk'),
].map(command => command.setDMPermission(false).toJSON());

export async function registerCommands(token: string, guildId: string, applicationId?: string): Promise<void> {
  const rest = new REST({ version: '10', timeout: 15000 }).setToken(token);
  if (!applicationId) {
    const application = await rest.get(Routes.oauth2CurrentApplication()) as { id: string };
    applicationId = application.id;
  }
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: commandDefinitions });
}

interface Dependencies {
  config: Config;
  leaders: LeaderService;
  status: () => Promise<string>;
  onError: (error: unknown) => void;
}
export function createCommandHandler({ config, leaders, status, onError }: Dependencies) {
  let accepting = true;
  const handle = async (interaction: ChatInputCommandInteraction): Promise<void> => {
    if (!['leader', 'status'].includes(interaction.commandName)) return;
    try {
      if (!accepting) throw new UserError('Dịch vụ đang dừng, vui lòng thử lại sau.');
      if (!interaction.inGuild() || interaction.guildId !== config.guildId) throw new UserError('Lệnh chỉ dùng trong server đã cấu hình.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (interaction.commandName === 'status') {
        await interaction.editReply({ content: await status(), allowedMentions: { parse: [] } });
        return;
      }
      const sub = interaction.options.getSubcommand();
      if (sub === 'list') {
        const snapshot = leaders.snapshot;
        await interaction.editReply({ content: TEAMS.map(team => `Team ${team}: ${snapshot[team] ? `<@${snapshot[team]}>` : 'Chưa có leader'}`).join('\n'), allowedMentions: { parse: [] } });
        return;
      }
      const team = interaction.options.getInteger('team', true);
      if (!isTeam(team)) throw new UserError('Team phải là 1, 2 hoặc 3.');
      if (sub === 'show') {
        const userId = leaders.snapshot[team];
        await interaction.editReply({ content: `Team ${team}: ${userId ? `<@${userId}>` : 'Chưa có leader'}`, allowedMentions: { parse: [] } });
        return;
      }
      if (!['set', 'remove'].includes(sub)) throw new UserError('Lệnh không hợp lệ.');
      // Fetch the actor on every mutation: do not rely on cached roles or command visibility.
      const actor = await interaction.guild!.members.fetch({ user: interaction.user.id, force: true });
      if (!actor.permissions.has(PermissionFlagsBits.ManageGuild) && !config.adminRoleIds.some(role => actor.roles.cache.has(role))) {
        throw new UserError('Bạn cần quyền Manage Server hoặc vai trò quản trị CrossTalk.');
      }
      if (sub === 'remove') {
        await leaders.change(team, null, actor.id);
        await interaction.editReply(`Đã gỡ leader Team ${team}. Team vẫn nghe được leader các team khác.`);
      } else {
        const user = interaction.options.getUser('user', true);
        let member;
        try { member = await interaction.guild!.members.fetch({ user: user.id, force: true }); }
        catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 10007) throw new UserError('Người được chọn không thuộc server này.');
          throw error;
        }
        if (member.user.bot) throw new UserError('Không thể gán bot làm leader.');
        await leaders.change(team, user.id, actor.id);
        const waiting = member.voice.channelId !== config.bots[team].channelId;
        await interaction.editReply({ content: `Đã gán <@${user.id}> làm leader Team ${team}.${waiting ? ' Relay sẽ bắt đầu khi leader vào đúng voice channel của team.' : ''}`, allowedMentions: { parse: [] } });
      }
    } catch (error) {
      if (!(error instanceof UserError)) onError(error);
      const content = error instanceof UserError ? error.message : 'Không thực hiện được thao tác. Hãy kiểm tra /leader list và /status trước khi thử lại.';
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content, allowedMentions: { parse: [] } });
        else await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      } catch (replyError) { onError(replyError); }
    }
  };
  return { handle, stop() { accepting = false; } };
}
