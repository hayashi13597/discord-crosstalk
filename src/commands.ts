import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, escapeMarkdown, MessageFlags,
  PermissionFlagsBits, REST, Routes, SlashCommandBuilder, type ChatInputCommandInteraction, type Interaction,
  type SlashCommandSubcommandBuilder } from 'discord.js';
import type { Config } from './config.js';
import type { RelayService } from './relays.js';
import { isTeam, TEAMS, UserError, targetVersion, type LeaderPresence, type RelayMutation, type RelaySnapshot, type RelayTeam } from './types.js';

const groupOption = (sub: SlashCommandSubcommandBuilder, required = true) => sub.addStringOption(option => option
  .setName('group').setDescription('Relay group').setRequired(required).setAutocomplete(true));
const channelOption = (sub: SlashCommandSubcommandBuilder, required = true) => sub.addChannelOption(option => option
  .setName('channel').setDescription('Voice channel của team').addChannelTypes(ChannelType.GuildVoice).setRequired(required));
const teamSelector = (sub: SlashCommandSubcommandBuilder) => channelOption(sub, false).addIntegerOption(option => option
  .setName('team').setDescription('Số team cũ của Group A (chọn team hoặc channel)').addChoices(...TEAMS.map(value => ({ name: `Team ${value}`, value }))));

export const commandDefinitions = [
  new SlashCommandBuilder().setName('group').setDescription('Quản lý relay groups')
    .addSubcommand(sub => sub.setName('create').setDescription('Tạo group paused').addStringOption(option => option.setName('name').setDescription('Tên group').setRequired(true).setMaxLength(80)))
    .addSubcommand(sub => sub.setName('list').setDescription('Liệt kê groups'))
    .addSubcommand(sub => groupOption(sub.setName('info').setDescription('Xem cấu hình và kết nối')))
    .addSubcommand(sub => groupOption(sub.setName('pause').setDescription('Tạm ngừng một group')))
    .addSubcommand(sub => groupOption(sub.setName('resume').setDescription('Tiếp tục một group')))
    .addSubcommand(sub => groupOption(sub.setName('delete').setDescription('Xóa group sau khi xác nhận'))),
  new SlashCommandBuilder().setName('team').setDescription('Quản lý voice teams')
    .addSubcommand(sub => channelOption(groupOption(sub.setName('add').setDescription('Thêm team vào group'))))
    .addSubcommand(sub => channelOption(sub.setName('remove').setDescription('Gỡ team sau khi xác nhận')))
    .addSubcommand(sub => groupOption(sub.setName('list').setDescription('Liệt kê teams của group'))),
  new SlashCommandBuilder().setName('leader').setDescription('Xem leaders theo role CrossTalk')
    .addSubcommand(sub => groupOption(sub.setName('list').setDescription('Xem leaders; mặc định Group A'), false))
    .addSubcommand(sub => teamSelector(sub.setName('show').setDescription('Xem leader của một team'))),
  new SlashCommandBuilder().setName('status').setDescription('Xem trạng thái groups và bots'),
].map(command => command.setDMPermission(false).toJSON());

export async function registerCommands(token: string, guildId: string, applicationId?: string): Promise<void> {
  const rest = new REST({ version: '10', timeout: 15000 }).setToken(token);
  if (!applicationId) applicationId = (await rest.get(Routes.oauth2CurrentApplication()) as { id: string }).id;
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: commandDefinitions });
}

type Pending = { actorId: string; expires: number } & (
  | { kind: 'confirm'; action: RelayMutation }
  | { kind: 'pages'; pages: string[] }
);
export function paginate(content: string): string[] {
  const pages: string[] = [];
  let current = '';
  for (const line of content.split('\n')) {
    for (let offset = 0; offset < Math.max(1, line.length); offset += 1750) {
      const part = line.slice(offset, offset + 1750);
      if (current.length + part.length + 1 > 1800) { pages.push(current); current = ''; }
      current += (current ? '\n' : '') + part;
    }
  }
  pages.push(current || 'Chưa có dữ liệu.');
  return pages;
}

export function formatLeaders(state: LeaderPresence | undefined): string {
  if (!state?.leadersKnown) return 'Chưa xác minh (bot offline hoặc đang đồng bộ)';
  return state.leaderIds.length ? state.leaderIds.map(id => `<@${id}>`).join(', ') : 'Chưa có leader trong voice';
}

interface Dependencies {
  config: Config;
  relays: RelayService;
  status: (groupId?: string) => Promise<string>;
  leaders: (team: RelayTeam) => LeaderPresence | undefined;
  onError: (error: unknown) => void;
}
export function createCommandHandler({ config, relays, status, leaders, onError }: Dependencies) {
  let accepting = true;
  const pending = new Map<string, Pending>();
  const cleanup = () => {
    for (const [key, value] of pending) if (value.expires <= Date.now()) pending.delete(key);
    // Keep bounded state even if a large server requests many pages at once.
    while (pending.size >= 1000) pending.delete(pending.keys().next().value!);
  };
  const admin = async (interaction: ChatInputCommandInteraction | Extract<Interaction, { customId: string }>) => {
    const actor = await interaction.guild!.members.fetch({ user: interaction.user.id, force: true });
    if (!actor.permissions.has(PermissionFlagsBits.ManageGuild) && !config.adminRoleIds.some(role => actor.roles.cache.has(role))) {
      throw new UserError('Bạn cần quyền Manage Server hoặc vai trò quản trị CrossTalk.');
    }
  };
  const groupFor = (interaction: ChatInputCommandInteraction, snapshot: RelaySnapshot, fallback = false) => {
    const id = interaction.options.getString('group');
    const group = id ? snapshot.groups.find(group => group.id === id) : fallback ? snapshot.groups.find(group => group.legacy) : undefined;
    if (!group) throw new UserError('Group không tồn tại. Hãy chọn group từ danh sách gợi ý.');
    return group;
  };
  const teamFor = (interaction: ChatInputCommandInteraction, snapshot: RelaySnapshot): RelayTeam => {
    const channel = interaction.options.getChannel('channel');
    const slot = interaction.commandName === 'leader' ? interaction.options.getInteger('team') : null;
    if ((!channel && slot === null) || (channel && slot !== null)) throw new UserError('Hãy chọn đúng một trong channel hoặc team:1/2/3.');
    if (slot !== null && !isTeam(slot)) throw new UserError('Team cũ phải là 1, 2 hoặc 3.');
    const team = snapshot.teams.find(team => channel ? team.channelId === channel.id : team.legacySlot === slot);
    if (!team) throw new UserError('Team không còn tồn tại hoặc channel chưa được gán. Số team cũ không được chuyển sang team khác.');
    return team;
  };
  const pageComponents = (id: string, index: number, count: number) => [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`ct:page:${id}:${index - 1}`).setLabel('Trước').setStyle(ButtonStyle.Secondary).setDisabled(index === 0),
    new ButtonBuilder().setCustomId(`ct:page:${id}:${index + 1}`).setLabel('Sau').setStyle(ButtonStyle.Secondary).setDisabled(index === count - 1),
  )];
  const respond = async (interaction: ChatInputCommandInteraction, content: string) => {
    const pages = paginate(content);
    if (pages.length === 1) { await interaction.editReply({ content: pages[0], components: [], allowedMentions: { parse: [] } }); return; }
    const id = randomUUID();
    pending.set(id, { kind: 'pages', actorId: interaction.user.id, expires: Date.now() + 600000, pages });
    await interaction.editReply({ content: `${pages[0]}\nTrang 1/${pages.length}`, components: pageComponents(id, 0, pages.length), allowedMentions: { parse: [] } });
  };
  const confirm = async (interaction: ChatInputCommandInteraction, action: RelayMutation, description: string) => {
    const id = randomUUID();
    pending.set(id, { kind: 'confirm', actorId: interaction.user.id, expires: Date.now() + 60000, action });
    await interaction.editReply({ content: `${description}\nXác nhận trong 60 giây.`, allowedMentions: { parse: [] }, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`ct:confirm:${id}`).setLabel('Xác nhận xóa').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`ct:cancel:${id}`).setLabel('Hủy').setStyle(ButtonStyle.Secondary),
    )] });
  };

  const handle = async (interaction: Interaction): Promise<void> => {
    if (interaction.isButton() ? !interaction.customId.startsWith('ct:') : !['group', 'team', 'leader', 'status'].includes('commandName' in interaction ? interaction.commandName : '')) return;
    cleanup();
    try {
      if (!accepting) throw new UserError('Dịch vụ đang dừng, vui lòng thử lại sau.');
      if (!interaction.inGuild() || interaction.guildId !== config.guildId) throw new UserError('Lệnh chỉ dùng trong server đã cấu hình.');
      if (interaction.isAutocomplete()) {
        const search = interaction.options.getFocused().toLowerCase();
        await interaction.respond(relays.snapshot.groups.filter(group => group.name.toLowerCase().includes(search))
          .slice(0, 25).map(group => ({ name: group.name, value: group.id })));
        return;
      }
      if (interaction.isButton()) {
        const [, kind, id, page] = interaction.customId.split(':');
        const value = pending.get(id!);
        if (!value) throw new UserError('Yêu cầu đã hết hạn hoặc đã xử lý. Hãy chạy lại lệnh.');
        if (value.actorId !== interaction.user.id) throw new UserError('Chỉ người chạy lệnh mới được sử dụng nút này.');
        if (value.kind === 'pages' && kind === 'page') {
          const index = Number(page);
          if (!Number.isInteger(index) || index < 0 || index >= value.pages.length) throw new UserError('Trang không hợp lệ.');
          await interaction.update({ content: `${value.pages[index]}\nTrang ${index + 1}/${value.pages.length}`, components: pageComponents(id!, index, value.pages.length), allowedMentions: { parse: [] } });
          return;
        }
        if (value.kind !== 'confirm' || !['confirm', 'cancel'].includes(kind!)) throw new UserError('Yêu cầu không hợp lệ.');
        await admin(interaction);
        // Recheck expiry after the permission fetch; remove before any await to prevent double submission.
        if (value.expires <= Date.now() || pending.get(id!) !== value) throw new UserError('Yêu cầu đã hết hạn hoặc đã xử lý.');
        pending.delete(id!);
        await interaction.deferUpdate();
        if (kind === 'confirm') await relays.mutate(value.action, interaction.user.id);
        await interaction.editReply({ content: kind === 'confirm' ? 'Đã xóa cấu hình được chọn.' : 'Đã hủy thao tác.', components: [], allowedMentions: { parse: [] } });
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (interaction.commandName === 'status') { await respond(interaction, await status()); return; }
      const sub = interaction.options.getSubcommand();
      const snapshot = relays.snapshot;
      if (interaction.commandName === 'group') {
        if (sub === 'list') {
          await respond(interaction, snapshot.groups.map(group => `${escapeMarkdown(group.name)}: ${group.state}; ${snapshot.teams.filter(team => team.groupId === group.id).length} team`).join('\n'));
          return;
        }
        if (sub === 'info') { await respond(interaction, await status(groupFor(interaction, snapshot).id)); return; }
        await admin(interaction);
        if (sub === 'create') {
          await relays.mutate({ kind: 'group.create', name: interaction.options.getString('name', true) }, interaction.user.id);
          await respond(interaction, 'Đã tạo group paused. Thêm team, gán role Leader cho thành viên rồi dùng /group resume.');
          return;
        }
        const group = groupFor(interaction, snapshot);
        if (sub === 'delete') {
          if (group.legacy) throw new UserError('Không được xóa Group A chứa ánh xạ team cũ.');
          await confirm(interaction, { kind: 'group.delete', groupId: group.id, expected: targetVersion(snapshot, 'group', group.id) }, `Xóa group ${escapeMarkdown(group.name)} và toàn bộ team trong group?`);
        } else if (sub === 'pause' || sub === 'resume') {
          await relays.mutate({ kind: 'group.state', groupId: group.id, state: sub === 'pause' ? 'paused' : 'active' }, interaction.user.id);
          await respond(interaction, sub === 'pause' ? 'Đã tạm ngừng relay của group.' : 'Đã bật group; các bot sẽ kết nối lại. Xem /group info để kiểm tra.');
        } else throw new UserError('Lệnh không hợp lệ.');
        return;
      }
      if (interaction.commandName === 'team') {
        if (sub === 'list') { await respond(interaction, await status(groupFor(interaction, snapshot).id)); return; }
        await admin(interaction);
        if (sub === 'remove') {
          const team = teamFor(interaction, snapshot);
          await confirm(interaction, { kind: 'team.remove', teamId: team.id, expected: targetVersion(snapshot, 'team', team.id) }, `Gỡ team <#${team.channelId}> khỏi relay group?`);
        } else if (sub === 'add') {
          const group = groupFor(interaction, snapshot);
          const channelId = interaction.options.getChannel('channel', true).id;
          const channel = await interaction.guild!.channels.fetch(channelId);
          if (channel?.type !== ChannelType.GuildVoice || channel.guildId !== config.guildId) throw new UserError('Hãy chọn voice channel thường trong server này; không dùng Stage.');
          await relays.mutate({ kind: 'team.add', groupId: group.id, channelId }, interaction.user.id);
          await respond(interaction, `Đã thêm team <#${channelId}> vào ${escapeMarkdown(group.name)}. ${group.state === 'paused' ? 'Group đang paused.' : 'Bot sẽ kết nối; xem /group info.'}`);
        } else throw new UserError('Lệnh không hợp lệ.');
        return;
      }
      if (sub === 'list') {
        const group = groupFor(interaction, snapshot, true);
        const lines = snapshot.teams.filter(team => team.groupId === group.id).map(team => `${team.legacySlot ? `Team ${team.legacySlot}` : `<#${team.channelId}>`}: ${formatLeaders(leaders(team))}`);
        await respond(interaction, `${escapeMarkdown(group.name)}\n${lines.join('\n') || 'Chưa có team.'}`);
        return;
      }
      if (sub === 'set' || sub === 'remove') {
        await respond(interaction, `Leader được xác định tự động theo role <@&${config.leaderRoleId}> (LEADER_ROLE_ID). Hãy thêm/gỡ role trên thành viên trong Discord.`);
        return;
      }
      const team = teamFor(interaction, snapshot);
      if (sub === 'show') { await respond(interaction, `<#${team.channelId}>: ${formatLeaders(leaders(team))}`); return; }
      throw new UserError('Lệnh không hợp lệ.');
    } catch (error) {
      if (!(error instanceof UserError)) onError(error);
      if (interaction.isAutocomplete()) { await interaction.respond([]).catch(onError); return; }
      if (!interaction.isRepliable()) return;
      const content = error instanceof UserError ? error.message : 'Không thực hiện được thao tác. Kiểm tra /status trước khi thử lại; cấu hình chưa xác nhận sẽ không được áp dụng.';
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content, components: [], allowedMentions: { parse: [] } });
        else await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      } catch (replyError) { onError(replyError); }
    }
  };
  return { handle, stop() { accepting = false; pending.clear(); } };
}
