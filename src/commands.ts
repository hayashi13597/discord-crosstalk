import { randomUUID } from 'node:crypto';
import { ApplicationCommandOptionType, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, escapeMarkdown, MessageFlags,
  PermissionFlagsBits, REST, Routes, SlashCommandBuilder, type ChatInputCommandInteraction, type Interaction,
  type SlashCommandSubcommandBuilder } from 'discord.js';
import { voiceSourceOptionNames } from './voice-move-types.js';
import type { Config } from './config.js';
import type { RelayService } from './relays.js';
import { UserError, targetVersion, type LeaderPresence, type RelayMutation, type RelaySnapshot, type RelayTeam } from './types.js';

const groupOption = (sub: SlashCommandSubcommandBuilder, required = true) => sub.addStringOption(option => option
  .setName('group').setDescription('Relay group').setRequired(required).setAutocomplete(true));
const channelOption = (sub: SlashCommandSubcommandBuilder) => sub.addChannelOption(option => option
  .setName('channel').setDescription('Voice channel của team').addChannelTypes(ChannelType.GuildVoice).setRequired(true));
export const commandDefinitions = [
  new SlashCommandBuilder().setName('help').setDescription('Xem tất cả lệnh và cách sử dụng'),
  new SlashCommandBuilder().setName('start').setDescription('Kết nối voice cho tất cả group active'),
  new SlashCommandBuilder().setName('stop').setDescription('Ngắt voice của tất cả bots'),
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
    .addSubcommand(sub => channelOption(sub.setName('show').setDescription('Xem leader của một team'))),
  new SlashCommandBuilder().setName('status').setDescription('Xem trạng thái groups và bots'),
  new SlashCommandBuilder().setName('voice').setDescription('Quản trị voice channels')
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers | PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub.setName('move-all').setDescription('Chuyển ngay từ các voice nguồn sang đích đã cài'))
    .addSubcommand(sub => {
      sub.setName('set-sources').setDescription('Chọn voice nguồn cho move-all (thay thế danh sách cũ)');
      for (const [index, name] of voiceSourceOptionNames.entries()) {
        sub.addChannelOption(option => option.setName(name).setDescription(`Voice nguồn ${index + 1}`)
          .addChannelTypes(ChannelType.GuildVoice).setRequired(index === 0));
      }
      return sub;
    })
    .addSubcommand(sub => sub.setName('move-config').setDescription('Xem voice nguồn và đích đã cài cho move-all'))
    .addSubcommand(sub => sub.setName('set-destination').setDescription('Cài voice đích mặc định cho move-all')
      .addChannelOption(option => option.setName('channel').setDescription('Voice đích mặc định')
        .addChannelTypes(ChannelType.GuildVoice).setRequired(true)))
    .addSubcommand(sub => sub.setName('move-status').setDescription('Xem tiến độ và audit của tác vụ di chuyển')
      .addStringOption(option => option.setName('job').setDescription('Job ID').setRequired(true).setMaxLength(36))),
].map(command => command.setDMPermission(false).toJSON());

// Derive the command list from registration so help stays complete as commands change.
const helpText = [
  '**Các lệnh CrossTalk**',
  'Tham số <...> là bắt buộc; [...] là tùy chọn. Chọn group từ danh sách gợi ý.',
  ...commandDefinitions.flatMap(command => {
    const subs = command.options?.filter(option => option.type === ApplicationCommandOptionType.Subcommand);
    if (!subs?.length) return [`\`/${command.name}\` — ${command.description}`];
    return subs.map(sub => {
      const args = sub.options?.map(option => option.required ? `${option.name}:<giá trị>` : `[${option.name}:giá trị]`).join(' ');
      return `\`/${command.name} ${sub.name}${args ? ` ${args}` : ''}\` — ${sub.description}`;
    });
  }),
  '',
  '**Quyền:** Các lệnh xem và /help dành cho mọi thành viên. /start, /stop và thay đổi group/team cần Manage Server hoặc role quản trị CrossTalk. /voice cần cả Manage Server và Move Members (hoặc Administrator).',
  '**Bắt đầu:** /team add → /start → /status. Group mới tạo đang paused: dùng /group resume. /start giữ nguyên group paused; trạng thái phiên /start được lưu và tự khôi phục sau restart.',
  'Leader được xác định theo role. Dùng /leader show channel:<voice> để xem leader trong channel.',
].join('\n');

export async function registerCommands(token: string, guildId: string, applicationId?: string): Promise<void> {
  const rest = new REST({ version: '10', timeout: 15000 }).setToken(token);
  if (!applicationId) applicationId = (await rest.get(Routes.oauth2CurrentApplication()) as { id: string }).id;
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: commandDefinitions });
}

interface PendingConfirm { actorId: string; expires: number; action: RelayMutation }
interface PendingPages { actorId: string; expires: number; pages: string[] }

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
  setSession?: (running: boolean) => Promise<void> | void;
  config: Config;
  relays: RelayService;
  status: (groupId?: string) => Promise<string>;
  leaders: (team: RelayTeam) => LeaderPresence | undefined;
  onError: (error: unknown) => void;
}
export function createCommandHandler({ config, relays, status, leaders, onError, setSession }: Dependencies) {
  let accepting = true;
  // Isolate admin confirmations from public pagination state so ordinary member pagination cannot evict pending confirmations.
  const confirmations = new Map<string, PendingConfirm>();
  const pages = new Map<string, PendingPages>();
  const sweep = <T extends { expires: number }>(map: Map<string, T>, max: number) => {
    const now = Date.now();
    for (const [key, value] of map) if (value.expires <= now) map.delete(key);
    while (map.size >= max) map.delete(map.keys().next().value!);
  };
  const cleanup = () => {
    sweep(confirmations, 200);
    sweep(pages, 1000);
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
    const channel = interaction.options.getChannel('channel', true);
    const team = snapshot.teams.find(team => team.channelId === channel.id);
    if (!team) throw new UserError('Channel chưa được gán cho team nào.');
    return team;
  };
  const pageComponents = (id: string, index: number, count: number) => [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`ct:page:${id}:${index - 1}`).setLabel('Trước').setStyle(ButtonStyle.Secondary).setDisabled(index === 0),
    new ButtonBuilder().setCustomId(`ct:page:${id}:${index + 1}`).setLabel('Sau').setStyle(ButtonStyle.Secondary).setDisabled(index === count - 1),
  )];
  const respond = async (interaction: ChatInputCommandInteraction, content: string) => {
    const items = paginate(content);
    if (items.length === 1) { await interaction.editReply({ content: items[0], components: [], allowedMentions: { parse: [] } }); return; }
    const id = randomUUID();
    pages.set(id, { actorId: interaction.user.id, expires: Date.now() + 600000, pages: items });
    await interaction.editReply({ content: `${items[0]}\nTrang 1/${items.length}`, components: pageComponents(id, 0, items.length), allowedMentions: { parse: [] } });
  };
  const confirm = async (interaction: ChatInputCommandInteraction, action: RelayMutation, description: string) => {
    const id = randomUUID();
    confirmations.set(id, { actorId: interaction.user.id, expires: Date.now() + 60000, action });
    await interaction.editReply({ content: `${description}\nXác nhận trong 60 giây.`, allowedMentions: { parse: [] }, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`ct:confirm:${id}`).setLabel('Xác nhận xóa').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`ct:cancel:${id}`).setLabel('Hủy').setStyle(ButtonStyle.Secondary),
    )] });
  };

  const handle = async (interaction: Interaction): Promise<void> => {
    if (interaction.isButton() ? !interaction.customId.startsWith('ct:') : !['help', 'start', 'stop', 'group', 'team', 'leader', 'status'].includes('commandName' in interaction ? interaction.commandName : '')) return;
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
        if (kind === 'page') {
          const value = pages.get(id!);
          if (!value) throw new UserError('Yêu cầu đã hết hạn hoặc đã xử lý. Hãy chạy lại lệnh.');
          if (value.actorId !== interaction.user.id) throw new UserError('Chỉ người chạy lệnh mới được sử dụng nút này.');
          const index = Number(page);
          if (!Number.isInteger(index) || index < 0 || index >= value.pages.length) throw new UserError('Trang không hợp lệ.');
          await interaction.update({ content: `${value.pages[index]}\nTrang ${index + 1}/${value.pages.length}`, components: pageComponents(id!, index, value.pages.length), allowedMentions: { parse: [] } });
          return;
        }
        if (!['confirm', 'cancel'].includes(kind!)) throw new UserError('Yêu cầu không hợp lệ.');
        const value = confirmations.get(id!);
        if (!value) throw new UserError('Yêu cầu đã hết hạn hoặc đã xử lý. Hãy chạy lại lệnh.');
        if (value.actorId !== interaction.user.id) throw new UserError('Chỉ người chạy lệnh mới được sử dụng nút này.');
        await admin(interaction);
        // Recheck expiry after the permission fetch; remove before any await to prevent double submission.
        if (value.expires <= Date.now() || confirmations.get(id!) !== value) throw new UserError('Yêu cầu đã hết hạn hoặc đã xử lý.');
        confirmations.delete(id!);
        await interaction.deferUpdate();
        if (kind === 'confirm') await relays.mutate(value.action, interaction.user.id);
        await interaction.editReply({ content: kind === 'confirm' ? 'Đã xóa cấu hình được chọn.' : 'Đã hủy thao tác.', components: [], allowedMentions: { parse: [] } });
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (interaction.commandName === 'help') { await respond(interaction, helpText); return; }
      if (interaction.commandName === 'status') { await respond(interaction, await status()); return; }
      if (interaction.commandName === 'start' || interaction.commandName === 'stop') {
        await admin(interaction);
        if (!setSession) throw new UserError('Điều khiển phiên chưa sẵn sàng.');
        const running = interaction.commandName === 'start';
        await setSession(running);
        await respond(interaction, running
          ? 'Đã bật phiên. Bot đang kết nối các channel của group active; group paused được giữ nguyên. Xem /status để kiểm tra kết quả.'
          : 'Đã dừng phiên và ngắt voice của tất cả bots. Dùng /start để kết nối lại.');
        return;
      }
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
          if (group.legacy) throw new UserError('Không được xóa Group A mặc định.');
          await confirm(interaction, { kind: 'group.delete', groupId: group.id, expected: targetVersion(snapshot, 'group', group.id) }, `Xóa group ${escapeMarkdown(group.name)} và toàn bộ team trong group?`);
        } else if (sub === 'pause' || sub === 'resume') {
          await relays.mutate({ kind: 'group.state', groupId: group.id, state: sub === 'pause' ? 'paused' : 'active' }, interaction.user.id);
          await respond(interaction, sub === 'pause' ? 'Đã tạm ngừng relay của group.' : 'Đã bật group; bot sẽ kết nối nếu phiên đã /start. Xem /group info để kiểm tra.');
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
          await respond(interaction, `Đã thêm team <#${channelId}> vào ${escapeMarkdown(group.name)}. ${group.state === 'paused' ? 'Group đang paused.' : 'Bot sẽ kết nối nếu phiên đã /start; xem /group info.'}`);
        } else throw new UserError('Lệnh không hợp lệ.');
        return;
      }
      if (sub === 'list') {
        const group = groupFor(interaction, snapshot, true);
        const lines = snapshot.teams.filter(team => team.groupId === group.id).map(team => `<#${team.channelId}>: ${formatLeaders(leaders(team))}`);
        await respond(interaction, `${escapeMarkdown(group.name)}\n${lines.join('\n') || 'Chưa có team.'}`);
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
  return { handle, stop() { accepting = false; confirmations.clear(); pages.clear(); } };
}
