import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, MessageFlags,
  StringSelectMenuBuilder, type ChatInputCommandInteraction, type Interaction, type InteractionEditReplyOptions, type REST } from 'discord.js';
import { UserError } from './types.js';
import { DiscordMoveGateway, requireMoveAdmin } from './voice-move-discord.js';
import { formatMoveJob, VoiceMoveService } from './voice-moves.js';
import type { MoveInput, MoveJob, MoveSnapshot } from './voice-move-types.js';

type ComponentInteraction = Extract<Interaction, { customId: string }>;
type PanelInteraction = ChatInputCommandInteraction | ComponentInteraction;
interface Session {
  id: string;
  guildId: string;
  actorId: string;
  revision: number;
  expires: number;
  busy: boolean;
  mode: 'select' | 'list' | 'preview';
  sources: Set<string>;
  staged: string[];
  destinationId: string | null;
  snapshot?: MoveSnapshot;
  page: number;
  timer?: NodeJS.Timeout;
  edit: (options: InteractionEditReplyOptions) => Promise<unknown>;
}
interface ResultPages { actorId: string; expires: number; pages: string[] }
const noMentions = { parse: [] as never[] };
const SESSION_MS = 600000;
const PREVIEW_MS = 60000;

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
  const deadline = (session: Session) => Math.min(session.expires, session.snapshot ? session.snapshot.takenAt + PREVIEW_MS : Infinity);
  const remove = (session: Session) => { sessions.delete(session.id); clearTimeout(session.timer); };
  const cancel = async (session: Session, reason: string) => {
    remove(session);
    await service.repository.create(inputFor(session), reason);
    await session.edit({ content: `Cancelled — ${reason}. Không di chuyển ai.\nJob: ${session.id}`, components: [], allowedMentions: noMentions }).catch(onError);
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
    const sources = [...session.sources];
    const sourcePages = chunks(session.snapshot
      ? session.snapshot.sources.map(source => `<#${source.id}>: ${source.humans} người; ${source.bots} bot`)
      : sources.map(id => `<#${id}>`));
    session.page = Math.max(0, Math.min(session.page, sourcePages.length - 1));
    const heading = `Mass Voice Move — đã chọn ${sources.length} nguồn\nĐích: ${session.destinationId ? `<#${session.destinationId}>` : 'chưa chọn'}\n`;
    const navigation = row(button(session, 'prev', 'Trước', session.page === 0), button(session, 'next', 'Sau', session.page === sourcePages.length - 1),
      button(session, 'back', 'Quay lại'), button(session, 'cancel', 'Hủy'));
    if (session.mode === 'preview') {
      const snapshot = session.snapshot!;
      return { content: heading + `${sourcePages[session.page]}\nTrang ${session.page + 1}/${sourcePages.length}\n` +
        `Tổng: ${snapshot.members.length} người; bỏ qua ${snapshot.botsSkipped} bot.\n` +
        `Đích hiện có ${snapshot.destinationOccupancy} người/bot; ${snapshot.destinationLimit ? `giới hạn ${snapshot.destinationLimit}, còn ${Math.max(0, snapshot.destinationLimit - snapshot.destinationOccupancy)} chỗ` : 'không đặt giới hạn người'}.\n` +
        'Leader rời channel team sẽ ngừng được relay từ team đó; cấu hình không đổi.\n' +
        'Chỉ người trong snapshot và vẫn ở nguồn khi xử lý mới được chuyển. Xác nhận trong 60 giây.',
      components: [navigation, row(button(session, 'confirm', 'Xác nhận', false, ButtonStyle.Danger))], allowedMentions: noMentions };
    }
    if (session.mode === 'list') {
      const pageIds = sources.slice(session.page * 20, (session.page + 1) * 20);
      const components: Array<NonNullable<InteractionEditReplyOptions['components']>[number]> = [];
      if (pageIds.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
        .setCustomId(`vm:${session.id}:${session.revision}:remove-page`).setPlaceholder('Chọn nguồn để xóa khỏi danh sách')
        .setMinValues(1).setMaxValues(pageIds.length).addOptions(pageIds.map(id => ({ label: `Nguồn ${id}`, value: id })))));
      components.push(navigation);
      return { content: heading + sourcePages[session.page] + `\nTrang ${session.page + 1}/${sourcePages.length}`,
        components, allowedMentions: noMentions };
    }
    return { content: heading + `Lượt đang chọn: ${session.staged.length} nguồn (chưa thêm).\n` +
      'Chọn 1–25 nguồn/lượt rồi bấm Thêm nguồn; lặp lại để thêm trên 25 nguồn.\nPhiên hết hạn sau 10 phút kể từ khi mở.',
    components: [
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder()
        .setCustomId(`vm:${session.id}:${session.revision}:sources`).setPlaceholder('Chọn nguồn cho lượt này')
        .setChannelTypes(ChannelType.GuildVoice).setMinValues(1).setMaxValues(25).setDefaultChannels(...session.staged)),
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder()
        .setCustomId(`vm:${session.id}:${session.revision}:destination`).setPlaceholder('Chọn một channel đích')
        .setChannelTypes(ChannelType.GuildVoice).setMinValues(1).setMaxValues(1)
        .setDefaultChannels(...(session.destinationId ? [session.destinationId] : []))),
      row(button(session, 'add', 'Thêm nguồn', !session.staged.length), button(session, 'remove', 'Xóa nguồn', !session.staged.length),
        button(session, 'clear', 'Xóa tất cả', !sources.length)),
      row(button(session, 'list', 'Danh sách đã chọn'), button(session, 'preview', 'Xem trước', !sources.length || !session.destinationId), button(session, 'cancel', 'Hủy')),
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
          busy: false, mode: 'select', sources: new Set(), staged: [], destinationId: null, page: 0, edit: options => interaction.editReply(options) };
        sessions.set(session.id, session);
        schedule(session);
        await session.edit(render(session));
        return;
      }
      if (!interaction.isButton() && !interaction.isChannelSelectMenu() && !interaction.isStringSelectMenu()) throw new UserError('Tương tác không hợp lệ.');
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
      await interaction.deferUpdate();
      stillValid(session);
      if (action === 'cancel') { await cancel(session, 'user_cancelled'); return; }
      await requireMoveAdmin(interaction.guild, interaction.user.id);
      stillValid(session);
      if (interaction.isChannelSelectMenu() && session.mode === 'select') {
        if (action === 'sources' && interaction.values.length >= 1 && interaction.values.length <= 25) session.staged = [...new Set(interaction.values)];
        else if (action === 'destination' && interaction.values.length === 1) session.destinationId = interaction.values[0]!;
        else throw new UserError('Lựa chọn không hợp lệ.');
      } else if (action === 'remove-page' && interaction.isStringSelectMenu() && session.mode === 'list') {
        const visible = [...session.sources].slice(session.page * 20, (session.page + 1) * 20);
        if (!interaction.values.length || interaction.values.some(id => !visible.includes(id))) throw new UserError('Nguồn cần xóa không hợp lệ.');
        for (const id of interaction.values) session.sources.delete(id);
      } else if (interaction.isButton()) {
        if (action === 'back') { session.snapshot = undefined; session.mode = 'select'; session.page = 0; }
        else if (action === 'prev' || action === 'next') session.page += action === 'next' ? 1 : -1;
        else if (session.mode === 'select' && action === 'add') { for (const id of session.staged) session.sources.add(id); session.staged = []; }
        else if (session.mode === 'select' && action === 'remove') { for (const id of session.staged) session.sources.delete(id); session.staged = []; }
        else if (session.mode === 'select' && action === 'clear') { session.sources.clear(); session.staged = []; }
        else if (session.mode === 'select' && action === 'list') { session.mode = 'list'; session.page = 0; }
        else if (session.mode === 'select' && action === 'preview') {
          if (session.staged.length) throw new UserError('Còn lượt nguồn chưa thêm. Bấm Thêm nguồn hoặc Xóa nguồn trước khi xem trước.');
          if (!session.destinationId) throw new UserError('Hãy chọn channel đích.');
          const snapshot = await new DiscordMoveGateway(interaction.guild, rest).snapshot(session.actorId, [...session.sources], session.destinationId);
          stillValid(session);
          session.snapshot = snapshot; session.mode = 'preview'; session.page = 0;
        } else if (session.mode === 'preview' && action === 'confirm') {
          const current = session;
          const gateway = new DiscordMoveGateway(interaction.guild, rest);
          stillValid(current);
          remove(current);
          await interaction.editReply({ content: `Đang bắt đầu Mass Voice Move.\nJob: ${current.id}`, components: [], allowedMentions: noMentions });
          await service.run(inputFor(current), gateway, async job => {
            if (job.status === 'Running') await interaction.editReply({ content: formatMoveJob(job), components: [], allowedMentions: noMentions });
            else await showResult(interaction, job);
          }, deadline(current));
          return;
        } else throw new UserError('Thao tác không hợp lệ cho bước hiện tại.');
      } else throw new UserError('Thao tác không hợp lệ.');
      session.revision++;
      await session.edit(render(session));
      schedule(session);
    } catch (error) {
      if (!(error instanceof UserError)) onError(error);
      const message = error instanceof UserError ? error.message : 'Không thể thực hiện. Không tự thử lại việc di chuyển; dùng /voice move-status nếu đã có Job ID.';
      const content = message + (session && ownsLock && sessions.get(session.id) !== session ? `\nJob: ${session.id}` : '');
      try {
        if (session && ownsLock && sessions.get(session.id) === session) {
          if (deadline(session) <= Date.now() || !accepting) await cancel(session, 'session_expired');
          else { session.revision++; await session.edit({ ...render(session), content: `${content}\n${render(session).content}` }); schedule(session); }
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
