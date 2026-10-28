import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags,
  type ChatInputCommandInteraction, type Interaction, type InteractionEditReplyOptions, type REST } from 'discord.js';
import { UserError } from './types.js';
import { DiscordMoveGateway, requireMoveAdmin } from './voice-move-discord.js';
import { formatMoveJob, VoiceMoveService } from './voice-moves.js';
import { voiceSourceOptionNames, moveCounts, type MoveInput, type MoveJob } from './voice-move-types.js';

type ComponentInteraction = Extract<Interaction, { customId: string }>;
type PanelInteraction = ChatInputCommandInteraction | ComponentInteraction;
interface ResultPages { actorId: string; expires: number; pages: string[] }
const noMentions = { parse: [] as never[] };
const SESSION_MS = 600000;

function chunks(lines: string[], size = 20): string[] {
  const pages: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (current.length && (current.length >= size || current.join('\n').length + line.length + 1 > 1500)) {
      pages.push(current.join('\n')); current = [];
    }
    current.push(line);
  }
  if (current.length) pages.push(current.join('\n'));
  return pages.length ? pages : ['Chưa có nguồn.'];
}
function compactResult(job: MoveJob, error?: string): string {
  if (job.status === 'Running' && !error) return 'Đang chuyển…';
  const counts = moveCounts(job);
  const summary = `Đã chuyển ${counts.moved} người; bỏ qua ${counts.skipped + job.botsSkipped}.`;
  const verification = job.verification;
  if (job.status === 'Completed' && !error && verification && !verification.remaining.length && !verification.unverified.length) {
    return `Đã chuyển hết người thật khỏi các nguồn tại lần kiểm tra cuối.\n${summary}\nJob: ${job.id}`;
  }
  const reasons: Record<string, string> = {
    members_remaining: 'Vẫn còn người trong nguồn sau các lần thử.', round_limit: 'Đã đạt giới hạn vòng quét.',
    time_limit: 'Đã hết thời gian xử lý (2 phút).', verification_failed: 'Chưa xác minh được tất cả người dùng.',
    destination_full: 'Voice đích đã đầy.', missing_permissions: 'Bot thiếu quyền di chuyển.',
    channel_unavailable: 'Voice không còn khả dụng.', rate_limited: 'Discord giới hạn yêu cầu.',
    outcome_unknown: 'Chưa xác định được kết quả di chuyển.', discord_unavailable: 'Discord không phản hồi.',
    voice_state_unverified: 'Không xác minh được trạng thái voice.',
    gateway_or_shutdown: 'Kết nối Discord hoặc dịch vụ đã dừng.',
    progress_delivery_failed: 'Không cập nhật được tiến độ.',
  };
  const checked = verification ? `Còn ở nguồn: ${verification.remaining.length}; chưa xác minh: ${verification.unverified.length} (lần kiểm tra cuối).` : 'Chưa xác minh được nguồn lúc kết thúc.';
  return `Đã dừng: ${error ?? reasons[job.reason ?? ''] ?? 'Không thể hoàn tất di chuyển.'}\n${summary}\n${checked}\nJob: ${job.id}`;
}

export function createVoiceMoveHandler({ guildId, service, rest, onError }: {
  guildId: string; service: VoiceMoveService; rest: REST; onError: (error: unknown) => void;
}) {
  const results = new Map<string, ResultPages>();
  const pending = new Set<Promise<unknown>>();
  let accepting = true;
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };
  const row = (...buttons: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
  const settingsText = (sourceIds: string[], destinationId: string | null) =>
    `Nguồn: ${sourceIds.length ? sourceIds.map(id => `<#${id}>`).join(', ') : 'chưa cài (/voice set-sources)'}\nĐích: ${destinationId ? `<#${destinationId}>` : 'chưa cài (/voice set-destination)'}`;
  const showResult = async (interaction: PanelInteraction, job: MoveJob) => {
    const lines = [
      ...job.sources.map(source => `Nguồn <#${source.id}>: ${source.humans} người; ${source.bots} bot`),
      ...(job.verification?.remaining.map(member => `Còn ở nguồn: ${member.userId} tại <#${member.sourceId}>`) ?? []),
      ...(job.verification?.unverified.map(id => `Chưa xác minh: ${id}`) ?? []),
      ...job.members.map(member => `${member.userId} từ <#${member.sourceId}>: ${member.status}${member.reason ? ` (${member.reason})` : ''}`),
    ];
    const pages = [...chunks(formatMoveJob(job).split('\n')), ...chunks(lines)];
    for (const [id, result] of results) if (result.expires <= Date.now()) results.delete(id);
    while (results.size >= 1000) results.delete(results.keys().next().value!);
    const id = randomUUID();
    results.set(id, { actorId: interaction.user.id, expires: Date.now() + SESSION_MS, pages });
    await interaction.editReply(resultPanel(id, pages, 0));
  };
  const resultPanel = (id: string, pages: string[], page: number): InteractionEditReplyOptions => ({
    content: pages[page] + `\nTrang ${page + 1}/${pages.length}`,
    components: [row(new ButtonBuilder().setCustomId(`vmr:${id}:${page - 1}`).setLabel('Trước').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`vmr:${id}:${page + 1}`).setLabel('Sau').setStyle(ButtonStyle.Secondary).setDisabled(page === pages.length - 1))], allowedMentions: noMentions,
  });

  const handle = async (interaction: Interaction): Promise<void> => {
    if (!(interaction.isChatInputCommand() && interaction.commandName === 'voice') &&
        !('customId' in interaction && /^(vm|vmr):/.test(interaction.customId))) return;
    if (!interaction.isRepliable()) return;
    let moveId: string | undefined;
    try {
      if (!accepting) throw new UserError('Dịch vụ đang dừng.');
      if (!interaction.inGuild() || interaction.guildId !== guildId || !interaction.guild) throw new UserError('Lệnh chỉ dùng trong server đã cấu hình.');
      if (interaction.isChatInputCommand()) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await requireMoveAdmin(interaction.guild, interaction.user.id);
        if (!accepting) throw new UserError('Dịch vụ đang dừng.');
        if (interaction.options.getSubcommand() === 'set-sources') {
          const channels = voiceSourceOptionNames.map((name, index) => interaction.options.getChannel(name, index === 0));
          const sourceIds = [...new Set(channels.flatMap(channel => channel ? [channel.id] : []))];
          if (!sourceIds.length || sourceIds.length > 25) throw new UserError('Cần từ 1 đến 25 voice nguồn.');
          for (const id of sourceIds) {
            const channel = await interaction.guild.channels.fetch(id, { force: true });
            if (channel?.type !== ChannelType.GuildVoice || channel.guildId !== guildId) {
              throw new UserError(`Channel ${id} không phải voice channel thường trong server này.`);
            }
          }
          if (!accepting) throw new UserError('Dịch vụ đang dừng.');
          await service.repository.setSources(guildId, sourceIds);
          await interaction.editReply({ content: `Đã lưu ${sourceIds.length} voice nguồn.\n${settingsText(sourceIds, await service.repository.getDestination(guildId))}`,
            components: [], allowedMentions: noMentions });
          return;
        }
        if (interaction.options.getSubcommand() === 'move-config') {
          const settings = await service.repository.getSettings(guildId);
          await interaction.editReply({ content: settingsText(settings.sourceIds, settings.destinationId), components: [], allowedMentions: noMentions });
          return;
        }
        if (interaction.options.getSubcommand() === 'set-destination') {
          const selected = interaction.options.getChannel('channel', true);
          const channel = await interaction.guild.channels.fetch(selected.id, { force: true });
          if (channel?.type !== ChannelType.GuildVoice || channel.guildId !== guildId) {
            throw new UserError('Hãy chọn voice channel thường trong server này; không dùng Stage.');
          }
          if (!accepting) throw new UserError('Dịch vụ đang dừng.');
          await service.repository.setDestination(guildId, channel.id);
          await interaction.editReply({ content: `Đã cài voice đích mặc định: <#${channel.id}>. /voice move-all sẽ chuyển ngay từ các nguồn đã lưu vào kênh này.`,
            components: [], allowedMentions: noMentions });
          return;
        }
        if (interaction.options.getSubcommand() === 'move-status') {
          const id = interaction.options.getString('job', true);
          if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new UserError('Job ID không hợp lệ.');
          const job = await service.repository.get(id, guildId);
          if (!job) throw new UserError('Không tìm thấy job trong server này hoặc đã hết thời gian lưu giữ.');
          await showResult(interaction, job);
          return;
        }
        if (interaction.options.getSubcommand() !== 'move-all') throw new UserError('Lệnh không hợp lệ.');
        const settings = await service.repository.getSettings(guildId);
        if (!settings.sourceIds.length || !settings.destinationId) {
          throw new UserError('Chưa đủ cấu hình. Dùng /voice set-sources và /voice set-destination trước khi chạy /voice move-all.');
        }
        const gateway = new DiscordMoveGateway(interaction.guild, rest);
        await interaction.editReply({ content: 'Đang chuyển…', components: [], allowedMentions: noMentions });
        const snapshot = await gateway.snapshot(interaction.user.id, settings.sourceIds, settings.destinationId);
        if (!accepting) throw new UserError('Dịch vụ đang dừng.');
        const input: MoveInput = { id: randomUUID(), guildId, actorId: interaction.user.id,
          sources: snapshot.sources, destinationId: snapshot.destinationId, snapshotAt: snapshot.takenAt,
          botsSkipped: snapshot.botsSkipped, members: snapshot.members };
        moveId = input.id;
        await service.run(input, gateway, async job => {
          await interaction.editReply({ content: compactResult(job), components: [], allowedMentions: noMentions });
        });
        return;
      }
      if (!interaction.isButton() && !interaction.isChannelSelectMenu()) throw new UserError('Tương tác không hợp lệ.');
      if (interaction.customId.startsWith('vmr:')) {
        const [, id, index] = interaction.customId.split(':');
        const result = results.get(id!);
        const page = Number(index);
        if (!result || result.expires <= Date.now()) throw new UserError('Trang kết quả đã hết hạn. Hãy dùng /voice move-status.');
        if (result.actorId !== interaction.user.id) throw new UserError('Chỉ người chạy lệnh được xem bảng này.');
        if (!Number.isInteger(page) || page < 0 || page >= result.pages.length) throw new UserError('Trang không hợp lệ.');
        await interaction.deferUpdate();
        await requireMoveAdmin(interaction.guild, interaction.user.id);
        await interaction.editReply(resultPanel(id!, result.pages, page));
        return;
      }
      throw new UserError('Bảng chọn cũ không còn dùng được. Hãy cài nguồn/đích rồi chạy /voice move-all.');
    } catch (error) {
      if (!(error instanceof UserError)) onError(error);
      const message = error instanceof UserError ? error.message : 'Không thể thực hiện di chuyển.';
      let content = message;
      if (moveId) {
        try {
          const job = await service.repository.get(moveId, guildId);
          if (job) content = compactResult(job, message);
        } catch (lookupError) { onError(lookupError); }
        if (!content.includes(`Job: ${moveId}`)) content += `\nJob: ${moveId}`;
      }
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content, components: [], allowedMentions: noMentions });
        else await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: noMentions });
      } catch (replyError) { onError(replyError); }
    }
  };
  return {
    handle: (interaction: Interaction) => track(handle(interaction)),
    async stop() {
      accepting = false;
      await service.stop();
      await Promise.allSettled([...pending]);
      results.clear();
    },
  };
}
