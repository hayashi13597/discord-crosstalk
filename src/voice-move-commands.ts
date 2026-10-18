import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, MessageFlags,
  type ChatInputCommandInteraction, type Interaction, type InteractionEditReplyOptions, type REST } from 'discord.js';
import { UserError } from './types.js';
import { DiscordMoveGateway, requireMoveAdmin } from './voice-move-discord.js';
import { formatMoveJob, VoiceMoveService } from './voice-moves.js';
import { moveCounts, type MoveInput, type MoveJob, type MoveSnapshot } from './voice-move-types.js';

type ComponentInteraction = Extract<Interaction, { customId: string }>;
type PanelInteraction = ChatInputCommandInteraction | ComponentInteraction;
interface Session {
  id: string;
  guildId: string;
  actorId: string;
  revision: number;
  expires: number;
  busy: boolean;
  sources: Set<string>;
  destinationId: string | null;
  snapshot?: MoveSnapshot;
  timer?: NodeJS.Timeout;
  edit: (options: InteractionEditReplyOptions) => Promise<unknown>;
}
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
function inputFor(session: Session): MoveInput {
  return { id: session.id, guildId: session.guildId, actorId: session.actorId,
    sources: session.snapshot?.sources ?? [...session.sources].map(id => ({ id, humans: 0, bots: 0 })),
    destinationId: session.destinationId, snapshotAt: session.snapshot?.takenAt ?? null,
    botsSkipped: session.snapshot?.botsSkipped ?? 0, members: session.snapshot?.members ?? [] };
}

function compactResult(job: MoveJob, error?: string): string {
  if (job.status === 'Running' && !error) return 'Đang chuyển…';
  const counts = moveCounts(job);
  const summary = `Đã chuyển ${counts.moved} người; bỏ qua ${counts.skipped + job.botsSkipped}.`;
  if (job.status === 'Completed' && !error) return summary;
  const reasons: Record<string, string> = {
    destination_full: 'Voice đích đã đầy.', missing_permissions: 'Bot thiếu quyền di chuyển.',
    channel_unavailable: 'Voice không còn khả dụng.', rate_limited: 'Discord giới hạn yêu cầu.',
    outcome_unknown: 'Chưa xác định được kết quả di chuyển.', discord_unavailable: 'Discord không phản hồi.',
    voice_state_unverified: 'Không xác minh được trạng thái voice.',
    gateway_or_shutdown: 'Kết nối Discord hoặc dịch vụ đã dừng.',
    progress_delivery_failed: 'Không cập nhật được tiến độ.',
  };
  return `Đã dừng: ${error ?? reasons[job.reason ?? ''] ?? 'Không thể hoàn tất di chuyển.'}\n${summary}\nJob: ${job.id}`;
}

export function createVoiceMoveHandler({ guildId, service, rest, onError }: {
  guildId: string; service: VoiceMoveService; rest: REST; onError: (error: unknown) => void;
}) {
  const sessions = new Map<string, Session>();
  const results = new Map<string, ResultPages>();
  const pending = new Set<Promise<unknown>>();
  let accepting = true;
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };
  const deadline = (session: Session) => Math.min(session.expires, session.snapshot ? session.snapshot.takenAt + 60000 : Infinity);
  const remove = (session: Session) => { sessions.delete(session.id); clearTimeout(session.timer); };
  const cancel = async (session: Session, reason: string) => {
    remove(session);
    await service.repository.create(inputFor(session), reason);
    await session.edit({ content: reason === 'user_cancelled' ? 'Đã hủy.' : 'Phiên đã kết thúc. Hãy mở lại /voice move-all.', components: [], allowedMentions: noMentions }).catch(onError);
  };
  const schedule = (session: Session) => {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      // An interaction holding the session lock will recheck the deadline itself.
      if (session.busy) { session.timer = setTimeout(() => schedule(session), 100); session.timer.unref(); return; }
      if (sessions.get(session.id) !== session) return;
      session.busy = true;
      void track(cancel(session, 'session_expired')).catch(onError);
    }, Math.max(1, deadline(session) - Date.now()));
    session.timer.unref();
  };
  const button = (session: Session, action: string, label: string, disabled = false, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(`vm:${session.id}:${session.revision}:${action}`).setLabel(label).setStyle(style).setDisabled(disabled);
  const row = (...buttons: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
  const render = (session: Session): InteractionEditReplyOptions => {
    return { content: 'Mass Voice Move', components: [
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder()
        .setCustomId(`vm:${session.id}:${session.revision}:sources`).setPlaceholder('Voice nguồn')
        .setChannelTypes(ChannelType.GuildVoice).setMinValues(1).setMaxValues(25).setDefaultChannels(...session.sources)),
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder()
        .setCustomId(`vm:${session.id}:${session.revision}:destination`).setPlaceholder('Voice đích')
        .setChannelTypes(ChannelType.GuildVoice).setMinValues(1).setMaxValues(1)
        .setDefaultChannels(...(session.destinationId ? [session.destinationId] : []))),
      row(button(session, 'confirm', 'Xác nhận', !session.sources.size || !session.destinationId, ButtonStyle.Danger),
        button(session, 'cancel', 'Hủy')),
    ], allowedMentions: noMentions };
  };
  const stillValid = (session: Session) => {
    if (!accepting || sessions.get(session.id) !== session || deadline(session) <= Date.now()) throw new UserError('Phiên đã hết hạn hoặc dịch vụ đang dừng. Hãy mở phiên mới.');
  };
  const showResult = async (interaction: PanelInteraction, job: MoveJob) => {
    const lines = [
      ...job.sources.map(source => `Nguồn <#${source.id}>: ${source.humans} người; ${source.bots} bot`),
      ...job.members.map(member => `${member.userId} từ <#${member.sourceId}>: ${member.status}${member.reason ? ` (${member.reason})` : ''}`),
    ];
    const pages = [formatMoveJob(job), ...chunks(lines)];
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
    let session: Session | undefined;
    let ownsLock = false;
    let confirming = false;
    try {
      if (!accepting) throw new UserError('Dịch vụ đang dừng.');
      if (!interaction.inGuild() || interaction.guildId !== guildId || !interaction.guild) throw new UserError('Lệnh chỉ dùng trong server đã cấu hình.');
      if (interaction.isChatInputCommand()) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await requireMoveAdmin(interaction.guild, interaction.user.id);
        if (!accepting) throw new UserError('Dịch vụ đang dừng.');
        if (interaction.options.getSubcommand() === 'move-status') {
          const id = interaction.options.getString('job', true);
          if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new UserError('Job ID không hợp lệ.');
          const job = await service.repository.get(id, guildId);
          if (!job) throw new UserError('Không tìm thấy job trong server này hoặc đã hết thời gian lưu giữ.');
          await showResult(interaction, job);
          return;
        }
        if (interaction.options.getSubcommand() !== 'move-all') throw new UserError('Lệnh không hợp lệ.');
        if (sessions.size >= 1000) throw new UserError('Có quá nhiều phiên đang mở. Hãy thử lại sau.');
        session = { id: randomUUID(), guildId, actorId: interaction.user.id, revision: 0, expires: Date.now() + SESSION_MS,
          busy: false, sources: new Set(), destinationId: null, edit: options => interaction.editReply(options) };
        sessions.set(session.id, session);
        schedule(session);
        await session.edit(render(session));
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
      const [, id, revision, action] = interaction.customId.split(':');
      session = sessions.get(id!);
      if (!session) throw new UserError('Phiên đã hết hạn hoặc đã xử lý. Hãy chạy lại /voice move-all.');
      if (session.actorId !== interaction.user.id) throw new UserError('Chỉ người gọi được thao tác phiên này.');
      if (session.busy || String(session.revision) !== revision) throw new UserError('Bảng đã thay đổi hoặc đang xử lý. Hãy dùng bảng mới nhất.');
      session.busy = true;
      ownsLock = true;
      confirming = interaction.isButton() && action === 'confirm';
      await interaction.deferUpdate();
      stillValid(session);
      if (action === 'cancel') { await cancel(session, 'user_cancelled'); return; }
      await requireMoveAdmin(interaction.guild, interaction.user.id);
      stillValid(session);
      if (interaction.isChannelSelectMenu()) {
        if (action === 'sources' && interaction.values.length >= 1 && interaction.values.length <= 25) session.sources = new Set(interaction.values);
        else if (action === 'destination' && interaction.values.length === 1) session.destinationId = interaction.values[0]!;
        else throw new UserError('Lựa chọn không hợp lệ.');
      } else if (confirming) {
        if (!session.sources.size || !session.destinationId) throw new UserError('Hãy chọn voice nguồn và voice đích.');
        const current = session;
        const gateway = new DiscordMoveGateway(interaction.guild, rest);
        await interaction.editReply({ content: 'Đang chuyển…', components: [], allowedMentions: noMentions });
        current.snapshot = await gateway.snapshot(current.actorId, [...current.sources], current.destinationId!);
        stillValid(current);
        remove(current);
        await service.run(inputFor(current), gateway, async job => {
          await interaction.editReply({ content: compactResult(job), components: [], allowedMentions: noMentions });
        }, deadline(current));
        return;
      } else throw new UserError('Thao tác không hợp lệ.');
      session.revision++;
      await session.edit(render(session));
      schedule(session);
    } catch (error) {
      if (!(error instanceof UserError)) onError(error);
      const message = error instanceof UserError ? error.message : 'Không thể thực hiện di chuyển.';
      let content = message;
      if (session && interaction.isChatInputCommand()) remove(session);
      if (session && ownsLock && confirming) {
        remove(session);
        // The job may not exist if confirmation failed before its audit was created.
        try {
          const job = await service.repository.get(session.id, guildId);
          if (job) content = compactResult(job, message);
        } catch (lookupError) { onError(lookupError); }
        if (!content.includes(`Job: ${session.id}`)) content += `\nJob: ${session.id}`;
      }
      try {
        if (session && ownsLock && sessions.get(session.id) === session) {
          if (deadline(session) <= Date.now() || !accepting) await cancel(session, 'session_expired');
          else { session.revision++; await session.edit({ ...render(session), content: `${content}\nMass Voice Move` }); schedule(session); }
        } else if (interaction.deferred || interaction.replied) await interaction.editReply({ content, components: [], allowedMentions: noMentions });
        else await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: noMentions });
      } catch (replyError) { onError(replyError); }
    } finally { if (session && ownsLock) session.busy = false; }
  };
  return {
    handle: (interaction: Interaction) => track(handle(interaction)),
    async stop() {
      accepting = false;
      for (const session of sessions.values()) clearTimeout(session.timer);
      await service.stop();
      await Promise.allSettled([...pending]);
      await Promise.allSettled([...sessions.values()].map(session => cancel(session, 'service_stopped')));
      results.clear();
    },
  };
}
