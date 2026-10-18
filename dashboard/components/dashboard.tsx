"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Activity,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowRight,
  AudioLines,
  Bot as BotIcon,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  ExternalLink,
  FileClock,
  Hash,
  Headphones,
  LayoutDashboard,
  LogOut,
  Menu,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  Shield,
  ShieldCheck,
  Users,
  Volume2,
  Waves,
  X,
  AlertTriangle,
  Pencil,
  Trash2,
} from "lucide-react";
import type {
  Access,
  Audit,
  Bot,
  Group,
  Job,
  Preview,
  Rule,
  Session,
  Snapshot,
  Team,
} from "@/lib/types";

type View =
  | "overview"
  | "groups"
  | "teams"
  | "leaders"
  | "move"
  | "bots"
  | "audit"
  | "settings";
const navigation = [
  {
    id: "overview",
    label: "Tổng quan",
    icon: LayoutDashboard,
    caption: "Mọi kết nối, trong tầm kiểm soát.",
  },
  {
    id: "groups",
    label: "Relay Groups",
    icon: Radio,
    caption: "Những cuộc trò chuyện, kết nối đúng nơi.",
  },
  {
    id: "teams",
    label: "Teams & Channels",
    icon: Headphones,
    caption: "Quản lý kênh voice và phân công bot.",
  },
  {
    id: "leaders",
    label: "Leaders",
    icon: Users,
    caption: "Theo dõi leader đang tham gia các kênh voice.",
  },
  {
    id: "move",
    label: "Di chuyển voice",
    icon: ArrowLeftRight,
    caption: "Chọn nguồn, xem trước và chuyển thành viên.",
  },
  {
    id: "bots",
    label: "Bots & Voice Health",
    icon: BotIcon,
    caption: "Trạng thái thực tế của từng kết nối.",
  },
  {
    id: "audit",
    label: "Nhật ký hoạt động",
    icon: FileClock,
    caption: "Theo dõi thay đổi và kết quả thao tác.",
  },
  {
    id: "settings",
    label: "Cài đặt & Phân quyền",
    icon: Settings2,
    caption: "Quyền truy cập phù hợp cho mỗi vai trò.",
  },
] as const;
const statusNames: Record<string, string> = {
  Active: "Hoạt động",
  Paused: "Tạm dừng",
  Degraded: "Cần kiểm tra",
  Offline: "Ngoại tuyến",
  Running: "Đang chuyển",
  Pending: "Đang xử lý",
  Applied: "Đã áp dụng",
  Failed: "Thất bại",
  Unknown: "Chưa xác định",
  Completed: "Hoàn tất",
  Cancelled: "Đã hủy",
  Interrupted: "Bị gián đoạn",
  "Partially Completed": "Hoàn tất một phần",
  moved: "Đã chuyển",
  skipped: "Bỏ qua",
  failed: "Thất bại",
  unknown: "Chưa rõ",
  pending: "Đang chờ",
  processing: "Đang chuyển",
};
const fmt = (value?: string | null) =>
  value
    ? new Date(value).toLocaleString("vi-VN", {
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "2-digit",
      })
    : "—";
function Badge({ value }: { value: string }) {
  return (
    <span
      className={`badge ${["Active", "Applied", "Completed", "moved", "ready"].includes(value) ? "green" : ["Paused", "Cancelled", "skipped"].includes(value) ? "neutral" : ["Running", "Pending", "processing", "pending"].includes(value) ? "purple" : "amber"}`}
    >
      <i />
      {statusNames[value] ?? value}
    </span>
  );
}
function Empty({
  title = "Chưa có dữ liệu",
  children,
}: {
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <AudioLines size={30} />
      <h3>{title}</h3>
      <p>{children ?? "Dữ liệu sẽ xuất hiện khi có hoạt động mới."}</p>
    </div>
  );
}
function Modal({
  title,
  description,
  children,
  close,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  close: () => void;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal">
          <div className="modal-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close aria-label="Đóng">
              <X size={19} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="muted">
            {description ?? "Kiểm tra thông tin trước khi xác nhận."}
          </Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
async function jsonRequest(path: string, init?: RequestInit) {
  const response = await fetch(path, { ...init, cache: "no-store" });
  const body = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(body.error?.message ?? "Không thể thực hiện thao tác."),
      { status: response.status, code: body.error?.code },
    );
  return body;
}

export default function Dashboard() {
  const [session, setSession] = useState<Session | null>(null),
    [loading, setLoading] = useState(true);
  const [data, setData] = useState<Snapshot | null>(null),
    [view, setView] = useState<View>("overview");
  const [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [offline, setOffline] = useState(true);
  const [menu, setMenu] = useState(false),
    [search, setSearch] = useState(""),
    [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<{
    kind: string;
    group?: Group;
    team?: Team;
    job?: Job;
  } | null>(null);
  const [pendingOperation, setPendingOperation] = useState<string | null>(null);
  const [sources, setSources] = useState<string[]>([]),
    [destination, setDestination] = useState(""),
    [sourceFilter, setSourceFilter] = useState("all");
  const [preview, setPreview] = useState<Preview | null>(null),
    [now, setNow] = useState(Date.now());
  const [job, setJob] = useState<Job | null>(null),
    [jobs, setJobs] = useState<
      { id: string; status: string; actor_id: string; created_at: string }[]
    >([]),
    [jobsPage, setJobsPage] = useState(0);
  const [recent, setRecent] = useState<Audit[]>([]);
  const [audits, setAudits] = useState<Audit[]>([]),
    [auditPage, setAuditPage] = useState(0),
    [auditMore, setAuditMore] = useState(false);
  const [auditActor, setAuditActor] = useState(""),
    [auditAction, setAuditAction] = useState(""),
    [auditGroup, setAuditGroup] = useState(""),
    [since, setSince] = useState(""),
    [until, setUntil] = useState("");
  const [rules, setRules] = useState<Rule[]>([]),
    [settingsExpected, setSettingsExpected] = useState("[]"),
    [roles, setRoles] = useState<{ id: string; name: string }[]>([]),
    [listLoading, setListLoading] = useState(false);
  const lastSnapshot = useRef(0);
  const fail = useCallback((e: unknown) => {
    setError(
      e instanceof Error ? e.message : "Dịch vụ tạm thời không sẵn sàng.",
    );
  }, []);
  const accept = useCallback((snapshot: Snapshot) => {
    setData(snapshot);
    lastSnapshot.current = Date.now();
    setOffline(false);
  }, []);
  const refresh = useCallback(async () => {
    try {
      accept(await jsonRequest("/api/control/snapshot"));
    } catch (e) {
      setOffline(true);
      fail(e);
    }
  }, [accept, fail]);
  const loadSession = useCallback(async () => {
    try {
      setSession(await jsonRequest("/api/session"));
      setError("");
    } catch (e) {
      if ((e as { status?: number }).status !== 401) fail(e);
    } finally {
      setLoading(false);
    }
  }, [fail]);
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("view");
    if (navigation.some((n) => n.id === value)) setView(value as View);
    const saved = sessionStorage.getItem("ct_pending");
    if (saved) setPendingOperation(saved);
    const authError = new URLSearchParams(window.location.search).get(
      "auth_error",
    );
    if (authError)
      setError(
        authError === "FORBIDDEN"
          ? "Tài khoản chưa có quyền truy cập server. Hãy liên hệ quản trị viên."
          : "Đăng nhập chưa hoàn tất. Kiểm tra cấu hình OAuth hoặc thử lại.",
      );
    void loadSession();
    const pop = () => {
      const next = new URLSearchParams(window.location.search).get("view");
      setView(
        navigation.some((n) => n.id === next) ? (next as View) : "overview",
      );
      setSearch("");
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [loadSession]);
  useEffect(() => {
    if (!session) return;
    void refresh();
    let fallback: ReturnType<typeof setInterval> | undefined;
    const stream = new EventSource("/api/events");
    stream.addEventListener("snapshot", (event) => {
      accept(JSON.parse((event as MessageEvent).data));
      if (fallback) {
        clearInterval(fallback);
        fallback = undefined;
      }
    });
    const reconnect = () => {
      setOffline(true);
      if (!fallback) fallback = setInterval(() => void refresh(), 5000);
    };
    stream.addEventListener("offline", reconnect);
    stream.onerror = reconnect;
    const ticker = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - lastSnapshot.current > 12000) setOffline(true);
    }, 1000);
    const recheck = setInterval(() => {
      void jsonRequest("/api/session")
        .then(setSession)
        .catch((e) => {
          if ([401, 403].includes(e.status)) {
            setSession(null);
            setData(null);
          } else setOffline(true);
        });
    }, 30000);
    return () => {
      stream.close();
      clearInterval(ticker);
      clearInterval(recheck);
      if (fallback) clearInterval(fallback);
    };
    // Session refresh updates permissions without restarting the stream.
  }, [session?.user.id, refresh, accept]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 6500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  const go = (next: View) => {
    setView(next);
    setSearch("");
    setMenu(false);
    history.pushState({}, "", `/?view=${next}`);
  };
  const post = async (path: string, body: unknown, key?: string) =>
    jsonRequest(`/api/control${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": session!.csrf,
        ...(key ? { "idempotency-key": key } : {}),
      },
      body: JSON.stringify(body),
    });
  const mutate = async (path: string, body: unknown) => {
    const id = crypto.randomUUID();
    setPendingOperation(id);
    sessionStorage.setItem("ct_pending", id);
    try {
      const result = await post(path, body, id);
      setPendingOperation(null);
      sessionStorage.removeItem("ct_pending");
      setToast(result.message ?? "Đã lưu thay đổi.");
      return result;
    } catch (e) {
      if (
        (e as { status?: number }).status &&
        (e as { status: number }).status < 500
      ) {
        setPendingOperation(null);
        sessionStorage.removeItem("ct_pending");
      }
      throw e;
    }
  };
  const checkOperation = async () => {
    if (!pendingOperation) return;
    try {
      const result = await jsonRequest(
        `/api/control/operations/${pendingOperation}`,
      );
      setToast(`Thao tác: ${statusNames[result.status] ?? result.status}`);
      if (result.status !== "Pending" && result.status !== "Unknown") {
        setPendingOperation(null);
        sessionStorage.removeItem("ct_pending");
        await refresh();
      }
    } catch (e) {
      fail(e);
    }
  };
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const loadJobs = useCallback(async () => {
    if (!session?.access.move) return;
    const result = await jsonRequest(`/api/control/moves?page=${jobsPage}`);
    setJobs(result.items);
  }, [session?.access.move, jobsPage]);
  useEffect(() => {
    if (view === "move") {
      setListLoading(true);
      void loadJobs()
        .catch(fail)
        .finally(() => setListLoading(false));
    }
  }, [view, loadJobs, fail]);
  useEffect(() => {
    if (!job || !["Running", "Pending"].includes(job.status)) return;
    const timer = setInterval(() => {
      void jsonRequest(`/api/control/moves/${job.id}`).then(setJob).catch(fail);
    }, 2000);
    return () => clearInterval(timer);
  }, [job?.id, job?.status, fail]);
  useEffect(() => {
    if (view !== "overview" || !session?.access.audit) return;
    let stopped = false;
    const load = () => {
      void jsonRequest("/api/control/audit?page=0")
        .then((result) => {
          if (!stopped) setRecent(result.items.slice(0, 5));
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 10000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [view, session?.access.audit]);
  useEffect(() => {
    if (view !== "audit" || !session?.access.audit) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setListLoading(true);
      const params = new URLSearchParams({
        page: String(auditPage),
        actor: auditActor,
        action: auditAction,
        group: auditGroup,
      });
      if (since) params.set("since", new Date(since).toISOString());
      if (until) params.set("until", new Date(until).toISOString());
      void jsonRequest(`/api/control/audit?${params}`, {
        signal: controller.signal,
      })
        .then((result) => {
          setAudits(result.items);
          setAuditMore(result.hasMore);
        })
        .catch((e) => {
          if (e.name !== "AbortError") fail(e);
        })
        .finally(() => setListLoading(false));
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    view,
    auditPage,
    auditActor,
    auditAction,
    auditGroup,
    since,
    until,
    session?.access.audit,
    fail,
  ]);
  useEffect(() => {
    if (view === "settings" && session?.access.settings) {
      setListLoading(true);
      void jsonRequest("/api/control/settings")
        .then((result) => {
          setRules(result.rules);
          setSettingsExpected(JSON.stringify(result.rules));
          setRoles(result.roles);
        })
        .catch(fail)
        .finally(() => setListLoading(false));
    }
  }, [view, session?.access.settings, fail]);
  if (loading)
    return (
      <div className="splash">
        <div className="brand-symbol">
          <AudioLines />
        </div>
        <p>Đang kết nối CrossTalk…</p>
      </div>
    );
  if (!session)
    return (
      <div className="login">
        <div className="login-orbit one" />
        <div className="login-orbit two" />
        <div className="login-content">
          <div className="brand">
            <span className="brand-symbol">
              <AudioLines />
            </span>
            CrossTalk<span className="version">CONTROL ROOM</span>
          </div>
          <span className="eyebrow">
            <i /> DISCORD VOICE, CONNECTED
          </span>
          <h1>
            Kết nối đồng đội.
            <br />
            <em>Làm chủ cuộc trò chuyện.</em>
          </h1>
          <p>
            Một nơi để quản lý relay groups, theo dõi kết nối và điều phối các
            kênh voice của bạn.
          </p>
          <a
            className="button primary login-button"
            href="/api/auth/discord/login"
          >
            <Users size={20} /> Đăng nhập bằng Discord <ArrowRight size={18} />
          </a>
          {error && (
            <div role="alert" className="notice error">
              {error}
              <button onClick={() => void loadSession()}>Thử lại</button>
            </div>
          )}
          <div className="login-foot">
            <ShieldCheck size={16} /> Chỉ dành cho thành viên được cấp quyền
          </div>
        </div>
        <div className="login-visual" aria-hidden="true">
          <div className="visual-ring">
            <AudioLines size={80} />
          </div>
          <span className="visual-pill">
            <i /> VOICE CONNECTED
          </span>
          <div className="wave-bars">
            {Array.from({ length: 37 }, (_, i) => (
              <i
                key={i}
                style={{
                  height: `${15 + Math.sin(i * 1.9) ** 2 * 80}px`,
                  animationDelay: `${i * 0.07}s`,
                }}
              />
            ))}
          </div>
        </div>
      </div>
    );
  const access = session.access,
    page = navigation.find((n) => n.id === view)!;
  const channels = data?.channels ?? [],
    groups = data?.groups ?? [],
    teams = data?.teams ?? [],
    bots = data?.bots ?? [];
  const channel = (id: string) => channels.find((c) => c.id === id);
  const teamName = (team: Team) =>
    team.name ??
    channel(team.channelId)?.name ??
    `Team ${team.legacySlot ?? team.workerId}`;
  const groupName = (id: string) =>
    groups.find((g) => g.id === id)?.name ?? "Group đã bị xóa";
  const memberName = (id: string) =>
    channels.flatMap((c) => c.members).find((m) => m.id === id)?.name ?? id;
  const matches = (...values: (string | undefined)[]) =>
    values.some((v) =>
      v?.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
    );
  const available = !offline && !!data && !busy;
  const leaderIds = [
    ...new Set(
      bots.filter((b) => b.leadersKnown).flatMap((b) => b.leaderIds ?? []),
    ),
  ];
  const voiceMembers = channels
    .filter((c) => teams.some((t) => t.channelId === c.id))
    .flatMap((c) => c.members)
    .filter((m) => !m.bot);
  const selectedChannels = channels.filter((c) => sources.includes(c.id));
  const visibleSources = channels.filter(
    (c) =>
      matches(c.name) &&
      (sourceFilter === "all" ||
        teams.some((t) => t.channelId === c.id && t.groupId === sourceFilter)),
  );
  const denied = (allowed: boolean, children: ReactNode) =>
    allowed ? (
      children
    ) : (
      <Empty title="Bạn chưa có quyền truy cập">
        Liên hệ quản trị viên để được cấp quyền phù hợp.
      </Empty>
    );
  const groupCard = (g: Group) => {
    const groupTeams = teams.filter((t) => t.groupId === g.id),
      leaders = groupTeams.flatMap(
        (t) => bots.find((b) => b.id === t.workerId)?.leaderIds ?? [],
      );
    const count = groupTeams.reduce(
      (sum, t) =>
        sum + (channel(t.channelId)?.members.filter((m) => !m.bot).length ?? 0),
      0,
    );
    return (
      <article className="group-card" key={g.id}>
        <div className="group-top">
          <span className={`group-symbol ${g.state === "paused" ? "dim" : ""}`}>
            <Radio size={23} />
          </span>
          <Badge value={g.actual} />
        </div>
        <div className="group-name">
          <h3>{g.name}</h3>
          {g.legacy && <span className="legacy">GỐC</span>}
        </div>
        <p>
          {groupTeams.length} team <span>·</span> {count} thành viên trong voice
        </p>
        <div className="channel-chips">
          {groupTeams.slice(0, 3).map((t) => (
            <span key={t.id}>
              <Volume2 size={13} />
              {teamName(t)}
            </span>
          ))}
          {groupTeams.length > 3 && <span>+{groupTeams.length - 3}</span>}
          {!groupTeams.length && <span>Chưa có team</span>}
        </div>
        <div className="group-bottom">
          <span>
            <Users size={14} /> {new Set(leaders).size} leader trong voice
          </span>
          {access.groups && (
            <div className="icon-actions">
              <button
                title={g.state === "active" ? "Tạm dừng group" : "Bật group"}
                aria-label={`${g.state === "active" ? "Tạm dừng" : "Bật"} ${g.name}`}
                disabled={!available}
                onClick={() => setModal({ kind: "state", group: g })}
              >
                {g.state === "active" ? (
                  <Pause size={15} />
                ) : (
                  <Play size={15} />
                )}
              </button>
              <button
                title="Đổi tên"
                aria-label={`Đổi tên ${g.name}`}
                disabled={!available}
                onClick={() => setModal({ kind: "rename", group: g })}
              >
                <Pencil size={15} />
              </button>
              {!g.legacy && (
                <button
                  title="Xóa group"
                  aria-label={`Xóa ${g.name}`}
                  disabled={!available}
                  onClick={() => setModal({ kind: "delete-group", group: g })}
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          )}
        </div>
      </article>
    );
  };
  const jobCounts = job
    ? Object.fromEntries(
        ["moved", "skipped", "failed", "unknown", "pending", "processing"].map(
          (s) => [s, job.members.filter((m) => m.status === s).length],
        ),
      )
    : {};
  return (
    <div className="app-shell">
      {menu && (
        <button
          className="mobile-scrim"
          aria-label="Đóng menu"
          onClick={() => setMenu(false)}
        />
      )}
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <button className="brand" onClick={() => go("overview")}>
          <span className="brand-symbol">
            <AudioLines size={23} />
          </span>
          CrossTalk
        </button>
        <div className="workspace">
          <span className="guild-avatar">
            {session.guild.name.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <strong>{session.guild.name}</strong>
            <span>Discord server</span>
          </div>
          <ShieldCheck size={16} />
        </div>
        <span className="nav-label">KHÔNG GIAN QUẢN TRỊ</span>
        <nav aria-label="Điều hướng chính">
          {navigation
            .filter(
              (n) =>
                (n.id !== "audit" || access.audit) &&
                (n.id !== "settings" || access.settings) &&
                (n.id !== "move" || access.move),
            )
            .map((item) => (
              <button
                key={item.id}
                className={view === item.id ? "selected" : ""}
                onClick={() => go(item.id)}
              >
                <item.icon size={18} />
                <span>{item.label}</span>
                {view === item.id && <i />}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="relay-note">
            <Waves size={19} />
            <strong>Giọng nói liền mạch</strong>
            <p>
              Đúng team. Đúng group.
              <br />
              Luôn giữ kết nối.
            </p>
          </div>
          <a
            className="help-link"
            href={`https://discord.com/channels/${session.guild.id}`}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={16} />
            Mở Discord
            <ArrowRight size={14} />
          </a>
          <div className="profile">
            <span className="user-avatar">
              {session.user.username.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>
                {session.user.global_name ?? session.user.username}
              </strong>
              <span>
                {access.admin
                  ? "Quản trị viên"
                  : access.groups || access.teams
                    ? "Operator"
                    : "Viewer"}
              </span>
            </div>
            <button
              aria-label="Đăng xuất"
              title="Đăng xuất"
              onClick={() =>
                void run(async () => {
                  await jsonRequest("/api/auth/logout", {
                    method: "POST",
                    headers: { "x-csrf-token": session.csrf },
                  });
                  window.location.assign("/");
                })
              }
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-area">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="mobile-menu"
              aria-label="Mở menu"
              onClick={() => setMenu(true)}
            >
              <Menu size={20} />
            </button>
            <span>Không gian quản trị</span>
            <ChevronRight size={14} />
            <strong>{page.label}</strong>
          </div>
          <div className="topbar-right">
            <span className={`connection ${offline ? "disconnected" : ""}`}>
              <i />
              {offline ? "Chưa kết nối" : "Hệ thống trực tuyến"}
            </span>
            <span className="divider" />
            <span className="top-icon">
              <Shield size={17} />
            </span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">CROSSTALK CONTROL ROOM</div>
              <h1>{page.label}</h1>
              <p>{page.caption}</p>
            </div>
            <button
              className="button subtle refresh"
              onClick={() => void refresh()}
              disabled={busy}
            >
              <RefreshCw size={15} />
              <span>Làm mới</span>
            </button>
          </div>
          {error && (
            <div className="notice error" role="alert">
              <AlertTriangle size={17} />
              <span>{error}</span>
              <button
                aria-label="Đóng thông báo lỗi"
                onClick={() => setError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {offline && (
            <div className="notice">
              <Clock3 size={17} />
              <span>
                {data
                  ? "Kết nối bị gián đoạn. Dữ liệu có thể đã cũ; thao tác thay đổi tạm khóa."
                  : "Đang chờ dữ liệu từ voice worker…"}
              </span>
            </div>
          )}
          {pendingOperation && (
            <div className="notice">
              <CircleHelp size={17} />
              <span>
                Thao tác {pendingOperation.slice(0, 8)} chưa được xác nhận kết
                quả.
              </span>
              <button onClick={() => void checkOperation()}>
                Kiểm tra trạng thái
              </button>
            </div>
          )}
          {!data && (
            <div className="skeleton-grid">
              {[0, 1, 2, 3].map((i) => (
                <div className="skeleton" key={i} />
              ))}
            </div>
          )}
          {data && view === "overview" && (
            <>
              <section className="overview-hero">
                <div>
                  <span className="hero-tag">
                    <Radio size={13} /> KHÔNG GIAN VOICE CỦA BẠN
                  </span>
                  <h2>Mọi team. Một kết nối.</h2>
                  <p>Theo dõi và điều phối các nhóm voice từ một nơi.</p>
                  <button
                    className="button hero-button"
                    onClick={() => go("groups")}
                  >
                    Quản lý Relay Groups <ArrowRight size={15} />
                  </button>
                </div>
                <div className="hero-visual" aria-hidden="true">
                  <div className="hero-center">
                    <AudioLines size={34} />
                  </div>
                  <span className="orbit-node n1">
                    <Volume2 size={20} />
                  </span>
                  <span className="orbit-node n2">
                    <Headphones size={20} />
                  </span>
                  <span className="orbit-node n3">
                    <Users size={20} />
                  </span>
                  <div className="hero-orbit" />
                  <div className="hero-orbit outer" />
                </div>
              </section>
              {bots
                .filter((b) => b.lastError)
                .slice(0, 3)
                .map((b) => (
                  <div key={b.id} className="notice">
                    <AlertTriangle size={17} />
                    <span>
                      {b.name}: {b.lastError}
                    </span>
                    <button onClick={() => go("bots")}>Kiểm tra bot</button>
                  </div>
                ))}
              <section className="stats-grid">
                {[
                  {
                    label: "Relay Groups",
                    value: groups.length,
                    icon: Radio,
                    detail: `${groups.filter((g) => g.actual === "Active").length} group đang hoạt động`,
                    color: "purple",
                  },
                  {
                    label: "Teams đã cấu hình",
                    value: teams.length,
                    icon: Headphones,
                    detail: `${bots.filter((b) => b.voice === "ready").length} kết nối voice sẵn sàng`,
                    color: "blue",
                  },
                  {
                    label: "Thành viên trong voice",
                    value: voiceMembers.length,
                    icon: Users,
                    detail: `${leaderIds.length} leader đã xác minh`,
                    color: "green",
                  },
                  {
                    label: "Bot trực tuyến",
                    value: `${bots.filter((b) => b.gateway).length}/${bots.length}`,
                    icon: BotIcon,
                    detail: bots.some((b) => !b.gateway)
                      ? "Có bot cần kiểm tra"
                      : "Gateway đang kết nối",
                    color: "orange",
                  },
                ].map((stat) => (
                  <article className="stat" key={stat.label}>
                    <div>
                      <span>{stat.label}</span>
                      <span className={`stat-icon ${stat.color}`}>
                        <stat.icon size={18} />
                      </span>
                    </div>
                    <strong>{stat.value}</strong>
                    <p>
                      <i className={stat.color} />
                      {stat.detail}
                    </p>
                  </article>
                ))}
              </section>
              <div className="section-heading">
                <div>
                  <h2>
                    Relay Groups <span className="count">{groups.length}</span>
                  </h2>
                  <p>Tách biệt cuộc trò chuyện, kết nối từng nhóm.</p>
                </div>
                <button className="text-button" onClick={() => go("groups")}>
                  Xem tất cả <ArrowRight size={15} />
                </button>
              </div>
              <section className="groups-grid">
                {groups.slice(0, 3).map(groupCard)}
                {!groups.length && <Empty title="Chưa có relay group" />}
              </section>
              <div className="bottom-grid">
                <section className="panel">
                  <div className="panel-heading">
                    <h2>
                      <Activity size={17} /> Trạng thái kết nối
                    </h2>
                    <Badge
                      value={
                        bots.some((b) => b.lastError)
                          ? "Degraded"
                          : bots.every((b) => b.gateway)
                            ? "Active"
                            : "Offline"
                      }
                    />
                  </div>
                  {bots.slice(0, 6).map((bot) => (
                    <div key={bot.id} className="bot-row">
                      <span className="small-bot">
                        <BotIcon size={19} />
                      </span>
                      <div>
                        <strong>{bot.name}</strong>
                        <span>
                          {bot.teamId
                            ? teamName(teams.find((t) => t.id === bot.teamId)!)
                            : "Chưa được phân công"}
                        </span>
                      </div>
                      <span className="bot-voice">
                        {bot.voice === "ready"
                          ? "Voice sẵn sàng"
                          : "Voice chưa sẵn sàng"}
                      </span>
                      <Badge value={bot.gateway ? "Active" : "Offline"} />
                    </div>
                  ))}
                </section>
                <section className="panel voice-panel">
                  <div className="panel-heading">
                    <h2>Thành viên theo kênh</h2>
                    <Volume2 size={17} />
                  </div>
                  {teams.slice(0, 5).map((t) => {
                    const count =
                      channel(t.channelId)?.members.filter((m) => !m.bot)
                        .length ?? 0;
                    return (
                      <div className="channel-meter" key={t.id}>
                        <div>
                          <span>{teamName(t)}</span>
                          <strong>
                            {count} <Users size={12} />
                          </strong>
                        </div>
                        <div className="meter">
                          <i
                            style={{
                              width: `${Math.min(100, (count / Math.max(1, voiceMembers.length)) * 100)}%`,
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                  {!teams.length && <Empty title="Chưa có team" />}
                </section>
              </div>
            </>
          )}
          {data && view === "overview" && access.audit && (
            <section className="panel recent-activity">
              <div className="panel-heading">
                <h2>
                  <FileClock size={17} />
                  Hoạt động gần đây
                </h2>
                <button className="text-button" onClick={() => go("audit")}>
                  Xem nhật ký
                  <ArrowRight size={14} />
                </button>
              </div>
              {recent.length ? (
                recent.map((a, index) => (
                  <div className="activity-row" key={`${a.id}-${index}`}>
                    <span className="activity-icon">
                      <Activity size={15} />
                    </span>
                    <div>
                      <strong>
                        {(
                          {
                            "group.create": "Tạo relay group",
                            "group.rename": "Đổi tên group",
                            "group.state": "Đổi trạng thái group",
                            "group.delete": "Xóa group",
                            "team.add": "Thêm team",
                            "team.update": "Cập nhật team",
                            "team.remove": "Gỡ team",
                            "voice.move": "Di chuyển voice",
                            "settings.update": "Cập nhật phân quyền",
                            "bot.status": "Thay đổi kết nối bot",
                          } as Record<string, string>
                        )[a.action] ?? a.action}
                      </strong>
                      <span>
                        {memberName(a.actor_id)} · {fmt(a.changed_at)}
                      </span>
                    </div>
                    <Badge value={a.result} />
                  </div>
                ))
              ) : (
                <Empty title="Chưa có hoạt động gần đây" />
              )}
            </section>
          )}
          {data && view === "groups" && (
            <>
              <div className="toolbar">
                <SearchBox
                  value={search}
                  set={setSearch}
                  placeholder="Tìm group hoặc trạng thái…"
                />
                <span className="muted">{groups.length} groups</span>
                {access.groups && (
                  <button
                    className="button primary"
                    disabled={!available}
                    onClick={() => setModal({ kind: "create-group" })}
                  >
                    <Plus size={16} />
                    Tạo group
                  </button>
                )}
              </div>
              <section className="groups-grid full">
                {groups
                  .filter((g) =>
                    matches(g.name, g.actual, statusNames[g.actual]),
                  )
                  .map(groupCard)}
              </section>
              {!groups.filter((g) =>
                matches(g.name, g.actual, statusNames[g.actual]),
              ).length && <Empty title="Không tìm thấy group" />}
            </>
          )}
          {data && view === "teams" && (
            <>
              <div className="toolbar">
                <SearchBox
                  value={search}
                  set={setSearch}
                  placeholder="Tìm team, channel hoặc group…"
                />
                {access.teams && (
                  <button
                    className="button primary"
                    disabled={!available || !groups.length}
                    onClick={() => setModal({ kind: "create-team" })}
                  >
                    <Plus size={16} />
                    Thêm team
                  </button>
                )}
              </div>
              <div className="panel table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Team / Channel</th>
                      <th>Relay Group</th>
                      <th>Bot</th>
                      <th>Thành viên</th>
                      <th>Kết nối voice</th>
                      <th>
                        <span className="sr-only">Thao tác</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {teams
                      .filter((t) =>
                        matches(teamName(t), groupName(t.groupId), t.channelId),
                      )
                      .map((t) => (
                        <tr key={t.id}>
                          <td>
                            <strong className="inline">
                              <Volume2 size={16} />
                              {teamName(t)}
                            </strong>
                            <small>
                              {t.channelId}
                              {t.legacySlot ? " · Team gốc" : ""}
                            </small>
                          </td>
                          <td>{groupName(t.groupId)}</td>
                          <td>Bot {t.workerId}</td>
                          <td>
                            {channel(t.channelId)?.members.filter((m) => !m.bot)
                              .length ?? 0}
                          </td>
                          <td>
                            <Badge
                              value={
                                bots.find((b) => b.id === t.workerId)?.voice ===
                                "ready"
                                  ? "Active"
                                  : "Offline"
                              }
                            />
                          </td>
                          <td>
                            {access.teams && (
                              <div className="icon-actions">
                                <button
                                  aria-label={`Sửa ${teamName(t)}`}
                                  disabled={!available}
                                  onClick={() =>
                                    setModal({ kind: "edit-team", team: t })
                                  }
                                >
                                  <Pencil size={16} />
                                </button>
                                <button
                                  aria-label={`Xóa ${teamName(t)}`}
                                  disabled={!available}
                                  onClick={() =>
                                    setModal({ kind: "delete-team", team: t })
                                  }
                                >
                                  <Trash2 size={16} />
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {!teams.length && <Empty title="Chưa có team" />}
              </div>
            </>
          )}
          {data && view === "leaders" && (
            <>
              <div className="notice">
                <ShieldCheck size={18} />
                <span>
                  Leader được xác định bởi role Discord{" "}
                  <code>{data.leaderRoleId}</code> và kênh voice hiện tại.
                  Thêm/gỡ role trực tiếp trên Discord.
                </span>
              </div>
              <div className="toolbar">
                <SearchBox
                  value={search}
                  set={setSearch}
                  placeholder="Tìm leader hoặc team…"
                />
                <span className="muted">
                  {leaderIds.length} leader đã xác minh
                </span>
              </div>
              <div className="groups-grid full">
                {teams
                  .filter((t) =>
                    matches(
                      teamName(t),
                      groupName(t.groupId),
                      ...(
                        bots.find((b) => b.id === t.workerId)?.leaderIds ?? []
                      ).map(memberName),
                    ),
                  )
                  .map((t) => {
                    const bot = bots.find((b) => b.id === t.workerId);
                    return (
                      <article className="panel leader-card" key={t.id}>
                        <div className="panel-heading">
                          <h3>
                            <Volume2 size={16} />
                            {teamName(t)}
                          </h3>
                          <span className="muted">{groupName(t.groupId)}</span>
                        </div>
                        {!bot?.leadersKnown ? (
                          <div className="notice compact">
                            <Clock3 size={16} />
                            Chưa xác minh leader — bot chưa sẵn sàng.
                          </div>
                        ) : !bot.leaderIds?.length ? (
                          <p className="muted">
                            Chưa có leader trong kênh voice.
                          </p>
                        ) : (
                          bot.leaderIds.map((id) => (
                            <div className="leader-row" key={id}>
                              <span className="leader-avatar">
                                {memberName(id).slice(0, 1)}
                              </span>
                              <div>
                                <strong>{memberName(id)}</strong>
                                <span>{id}</span>
                              </div>
                              <span className="live-label">
                                <i />
                                Trong voice
                              </span>
                            </div>
                          ))
                        )}
                      </article>
                    );
                  })}
              </div>
            </>
          )}
          {data && view === "bots" && (
            <>
              <div className="toolbar">
                <SearchBox
                  value={search}
                  set={setSearch}
                  placeholder="Tìm bot hoặc team…"
                />
                <span className="muted">{bots.length} bot accounts</span>
              </div>
              <div className="groups-grid full">
                {bots
                  .filter((b) =>
                    matches(
                      b.name,
                      b.teamId
                        ? teamName(teams.find((t) => t.id === b.teamId)!)
                        : "trống",
                    ),
                  )
                  .map((b) => (
                    <article className="panel bot-card" key={b.id}>
                      <div className="group-top">
                        <span className="group-symbol">
                          <BotIcon size={25} />
                        </span>
                        <Badge value={b.gateway ? "Active" : "Offline"} />
                      </div>
                      <h3>{b.name}</h3>
                      <code>{b.userId ?? "Chưa xác minh danh tính"}</code>
                      <p className="muted">
                        {b.teamId
                          ? teamName(teams.find((t) => t.id === b.teamId)!)
                          : b.reserved
                            ? "Giữ cho team gốc"
                            : "Sẵn sàng phân công"}
                      </p>
                      <dl>
                        <div>
                          <dt>Gateway</dt>
                          <dd>{b.gateway ? "Đã kết nối" : "Ngoại tuyến"}</dd>
                        </div>
                        <div>
                          <dt>Voice</dt>
                          <dd>
                            {b.voice === "ready"
                              ? "Sẵn sàng"
                              : (b.voice ?? "Chưa kết nối")}
                          </dd>
                        </div>
                        <div>
                          <dt>Leader đã xác minh</dt>
                          <dd>
                            {b.leadersKnown
                              ? (b.leaderIds?.length ?? 0)
                              : "Chưa xác minh"}
                          </dd>
                        </div>
                        <div>
                          <dt>Nhận giọng leader</dt>
                          <dd>{b.receiving ? "Sẵn sàng" : "Chưa sẵn sàng"}</dd>
                        </div>
                      </dl>
                      {b.lastError && (
                        <div className="notice compact error">
                          {b.lastError}
                        </div>
                      )}
                    </article>
                  ))}
              </div>
            </>
          )}
          {data &&
            view === "move" &&
            denied(
              access.move,
              <>
                <div className="stepper">
                  <span className={!preview ? "current" : ""}>
                    <i>1</i>Chọn kênh
                  </span>
                  <b />
                  <span className={preview ? "current" : ""}>
                    <i>2</i>Xem trước
                  </span>
                  <b />
                  <span className={job ? "current" : ""}>
                    <i>3</i>Kết quả
                  </span>
                </div>
                <div className="move-grid">
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>
                        <Volume2 size={18} /> Kênh nguồn
                      </h2>
                      <span className="count">{sources.length} đã chọn</span>
                    </div>
                    <div className="source-tools">
                      <SearchBox
                        value={search}
                        set={setSearch}
                        placeholder="Tìm voice channel…"
                      />
                      <select
                        aria-label="Lọc theo group"
                        value={sourceFilter}
                        onChange={(e) => setSourceFilter(e.target.value)}
                      >
                        <option value="all">Tất cả groups</option>
                        {groups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="select-all">
                      <button
                        onClick={() => {
                          setSources([
                            ...new Set([
                              ...sources,
                              ...visibleSources
                                .filter((c) => c.id !== destination)
                                .map((c) => c.id),
                            ]),
                          ]);
                          setPreview(null);
                        }}
                      >
                        Chọn tất cả kết quả
                      </button>
                      <button
                        onClick={() => {
                          setSources([]);
                          setPreview(null);
                        }}
                      >
                        Bỏ chọn tất cả
                      </button>
                    </div>
                    <div className="source-list">
                      {visibleSources.map((c) => (
                        <label
                          className={`source-option ${sources.includes(c.id) ? "checked" : ""}`}
                          key={c.id}
                        >
                          <input
                            type="checkbox"
                            disabled={c.id === destination || busy}
                            checked={sources.includes(c.id)}
                            onChange={(e) => {
                              setSources(
                                e.target.checked
                                  ? [...sources, c.id]
                                  : sources.filter((id) => id !== c.id),
                              );
                              setPreview(null);
                            }}
                          />
                          <Volume2 size={17} />
                          <span>
                            <strong>{c.name}</strong>
                            <small>
                              {teams.some((t) => t.channelId === c.id)
                                ? groupName(
                                    teams.find((t) => t.channelId === c.id)!
                                      .groupId,
                                  )
                                : "Ngoài relay groups"}
                            </small>
                          </span>
                          <span className="member-count">
                            {c.members.filter((m) => !m.bot).length}
                            <Users size={13} />
                          </span>
                        </label>
                      ))}
                    </div>
                  </section>
                  <section className="panel destination-panel">
                    <span className="group-symbol">
                      <ArrowDownToLine size={24} />
                    </span>
                    <h2>Chuyển đến đâu?</h2>
                    <p className="muted">
                      Chọn một kênh đích khác các kênh nguồn.
                    </p>
                    <label>
                      Kênh đích
                      <select
                        aria-label="Kênh đích"
                        value={destination}
                        onChange={(e) => {
                          setDestination(e.target.value);
                          setPreview(null);
                        }}
                        disabled={busy}
                      >
                        <option value="">Chọn voice channel</option>
                        {channels
                          .filter((c) => !sources.includes(c.id))
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <div className="move-summary">
                      <div>
                        <span>Kênh nguồn</span>
                        <strong>{sources.length}</strong>
                      </div>
                      <div>
                        <span>Người hiện trong nguồn</span>
                        <strong>
                          {selectedChannels.reduce(
                            (sum, c) =>
                              sum + c.members.filter((m) => !m.bot).length,
                            0,
                          )}
                        </strong>
                      </div>
                      <div>
                        <span>Bot được bỏ qua</span>
                        <strong>
                          {selectedChannels.reduce(
                            (sum, c) =>
                              sum + c.members.filter((m) => m.bot).length,
                            0,
                          )}
                        </strong>
                      </div>
                    </div>
                    <div className="muted small">
                      <ShieldCheck size={15} /> Tất cả bot sẽ ở nguyên vị trí.
                    </div>
                    <button
                      className="button primary wide"
                      disabled={!available || !sources.length || !destination}
                      onClick={() =>
                        void run(async () => {
                          setPreview(
                            await post("/moves/preview", {
                              id: crypto.randomUUID(),
                              sources,
                              destinationId: destination,
                            }),
                          );
                        })
                      }
                    >
                      {busy ? "Đang xác minh…" : "Xem trước di chuyển"}
                      <ArrowRight size={16} />
                    </button>
                  </section>
                </div>
                {preview && (
                  <section className="panel preview-panel">
                    <div className="panel-heading">
                      <h2>Xác nhận di chuyển</h2>
                      <span className="muted">
                        Hết hạn sau{" "}
                        {Math.max(
                          0,
                          Math.ceil((preview.expiresAt - now) / 1000),
                        )}
                        s
                      </span>
                    </div>
                    <p>
                      <strong>{preview.members.length} người</strong> từ{" "}
                      {preview.sources.length} nguồn →{" "}
                      <strong>
                        {channel(preview.destinationId)?.name ??
                          preview.destinationId}
                      </strong>
                      . Bỏ qua {preview.botsSkipped} bot.
                    </p>
                    <div className="channel-chips">
                      {preview.sources.map((s) => (
                        <span key={s.id}>
                          {channel(s.id)?.name ?? s.id}: {s.humans} người
                        </span>
                      ))}
                    </div>
                    <p className="muted">
                      Đích hiện có {preview.destinationOccupancy} người/bot ·
                      Sức chứa {preview.destinationLimit || "không giới hạn"}.
                      Người vào nguồn sau preview sẽ không được thêm vào job.
                    </p>
                    {preview.leaders.length > 0 && (
                      <div className="notice">
                        <AlertTriangle size={18} />
                        {preview.leaders.length} leader sẽ rời kênh hiện tại;
                        relay của họ thay đổi theo vị trí voice.
                      </div>
                    )}
                    <div className="form-actions">
                      <button
                        className="button subtle"
                        onClick={() => setPreview(null)}
                      >
                        Hủy preview
                      </button>
                      <button
                        className="button primary"
                        disabled={!available || preview.expiresAt <= now}
                        onClick={() =>
                          void run(async () => {
                            const result = await post("/moves/confirm", {
                              previewId: preview.id,
                            });
                            setPreview(null);
                            setJob(
                              await jsonRequest(
                                `/api/control/moves/${result.id}`,
                              ),
                            );
                            await loadJobs();
                          })
                        }
                      >
                        <CheckCheck size={16} />
                        Xác nhận chuyển {preview.members.length} người
                      </button>
                    </div>
                  </section>
                )}
                {job && (
                  <section className="panel job-panel">
                    <div className="panel-heading">
                      <h2>Tiến độ di chuyển</h2>
                      <Badge value={job.status} />
                    </div>
                    <code className="job-id">{job.id}</code>
                    <div className="job-stats">
                      {[
                        ["Đã chuyển", jobCounts.moved],
                        ["Bỏ qua", jobCounts.skipped],
                        [
                          "Lỗi / chưa rõ",
                          (jobCounts.failed ?? 0) + (jobCounts.unknown ?? 0),
                        ],
                        [
                          "Đang chờ",
                          (jobCounts.pending ?? 0) +
                            (jobCounts.processing ?? 0),
                        ],
                      ].map(([label, count]) => (
                        <div key={label}>
                          <strong>{count}</strong>
                          <span>{label}</span>
                        </div>
                      ))}
                    </div>
                    {job.reason && (
                      <div className="notice">
                        <AlertTriangle size={16} />
                        {job.reason}. Kiểm tra kết quả từng người trước khi tạo
                        job mới.
                      </div>
                    )}
                    <div className="table-wrap job-results">
                      <table>
                        <thead>
                          <tr>
                            <th>Thành viên</th>
                            <th>Kênh nguồn</th>
                            <th>Kết quả</th>
                            <th>Nguyên nhân</th>
                          </tr>
                        </thead>
                        <tbody>
                          {job.members.map((m) => (
                            <tr key={m.userId}>
                              <td>{memberName(m.userId)}</td>
                              <td>{channel(m.sourceId)?.name ?? m.sourceId}</td>
                              <td>
                                <Badge value={m.status} />
                              </td>
                              <td>{m.reason ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {job.status === "Running" && (
                      <button
                        className="button danger"
                        disabled={!available}
                        onClick={() => setModal({ kind: "cancel-job", job })}
                      >
                        Hủy phần chưa xử lý
                      </button>
                    )}
                  </section>
                )}
                <section className="panel job-history">
                  <div className="panel-heading">
                    <h2>Lịch sử di chuyển</h2>
                    <button
                      className="text-button"
                      onClick={() => void loadJobs().catch(fail)}
                    >
                      <RefreshCw size={14} />
                      Làm mới
                    </button>
                  </div>
                  {listLoading ? (
                    <p className="muted">Đang tải…</p>
                  ) : jobs.length ? (
                    <>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Job ID</th>
                              <th>Người thực hiện</th>
                              <th>Thời gian</th>
                              <th>Trạng thái</th>
                              <th />
                            </tr>
                          </thead>
                          <tbody>
                            {jobs.slice(0, 50).map((j) => (
                              <tr key={j.id}>
                                <td>
                                  <code>{j.id.slice(0, 8)}</code>
                                </td>
                                <td>{memberName(j.actor_id)}</td>
                                <td>{fmt(j.created_at)}</td>
                                <td>
                                  <Badge value={j.status} />
                                </td>
                                <td>
                                  <button
                                    className="text-button"
                                    onClick={() =>
                                      void run(async () =>
                                        setJob(
                                          await jsonRequest(
                                            `/api/control/moves/${j.id}`,
                                          ),
                                        ),
                                      )
                                    }
                                  >
                                    Chi tiết
                                    <ChevronRight size={14} />
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <Pager
                        page={jobsPage}
                        more={jobs.length > 50}
                        set={setJobsPage}
                      />
                    </>
                  ) : (
                    <Empty title="Chưa có tác vụ di chuyển" />
                  )}
                </section>
              </>,
            )}
          {data &&
            view === "audit" &&
            denied(
              access.audit,
              <>
                <div className="audit-filters">
                  <label>
                    Người thực hiện
                    <input
                      placeholder="Discord ID"
                      value={auditActor}
                      onChange={(e) => {
                        setAuditActor(e.target.value);
                        setAuditPage(0);
                      }}
                    />
                  </label>
                  <label>
                    Hành động
                    <input
                      placeholder="Ví dụ: group, voice…"
                      value={auditAction}
                      onChange={(e) => {
                        setAuditAction(e.target.value);
                        setAuditPage(0);
                      }}
                    />
                  </label>
                  <label>
                    Relay Group
                    <select
                      value={auditGroup}
                      onChange={(e) => {
                        setAuditGroup(e.target.value);
                        setAuditPage(0);
                      }}
                    >
                      <option value="">Tất cả</option>
                      {groups.map((g) => (
                        <option value={g.id} key={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Từ
                    <input
                      type="datetime-local"
                      value={since}
                      onChange={(e) => {
                        setSince(e.target.value);
                        setAuditPage(0);
                      }}
                    />
                  </label>
                  <label>
                    Đến
                    <input
                      type="datetime-local"
                      value={until}
                      onChange={(e) => {
                        setUntil(e.target.value);
                        setAuditPage(0);
                      }}
                    />
                  </label>
                </div>
                <div className="panel table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Thời gian</th>
                        <th>Người thực hiện</th>
                        <th>Hành động</th>
                        <th>Kết quả</th>
                        <th>Chi tiết</th>
                      </tr>
                    </thead>
                    <tbody>
                      {audits.map((a, i) => (
                        <tr key={`${a.id}-${i}`}>
                          <td>{fmt(a.changed_at)}</td>
                          <td>{memberName(a.actor_id)}</td>
                          <td>
                            <code>{a.action}</code>
                          </td>
                          <td>
                            <Badge value={a.result} />
                          </td>
                          <td>
                            <details>
                              <summary>Xem</summary>
                              <pre>{JSON.stringify(a.details, null, 2)}</pre>
                            </details>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {listLoading && (
                    <p className="loading-line">Đang tải nhật ký…</p>
                  )}
                  {!listLoading && !audits.length && (
                    <Empty title="Chưa có hoạt động phù hợp" />
                  )}
                  <Pager page={auditPage} more={auditMore} set={setAuditPage} />
                </div>
              </>,
            )}
          {data &&
            view === "settings" &&
            denied(
              access.settings,
              <>
                <div className="notice">
                  <ShieldCheck size={18} />
                  <span>
                    Quản trị viên có Manage Server luôn có quyền quản lý. Mass
                    Move vẫn yêu cầu Manage Server và Move Members; role
                    Operator không thay thế hai quyền này.
                  </span>
                </div>
                <section className="panel settings-panel">
                  <div className="panel-heading">
                    <h2>Vai trò được cấp quyền</h2>
                    <button
                      className="button subtle"
                      disabled={
                        !available ||
                        listLoading ||
                        roles.every((r) =>
                          rules.some((rule) => rule.roleId === r.id),
                        )
                      }
                      onClick={() => {
                        const role = roles.find(
                          (r) => !rules.some((rule) => rule.roleId === r.id),
                        );
                        if (role)
                          setRules([
                            ...rules,
                            {
                              roleId: role.id,
                              level: "viewer",
                              capabilities: [],
                            },
                          ]);
                      }}
                    >
                      <Plus size={15} />
                      Thêm vai trò
                    </button>
                  </div>
                  {listLoading ? (
                    <p className="muted">Đang tải…</p>
                  ) : (
                    rules.map((rule, index) => (
                      <div className="permission-row" key={index}>
                        <label>
                          Vai trò Discord
                          <select
                            value={rule.roleId}
                            onChange={(e) =>
                              setRules(
                                rules.map((r, i) =>
                                  i === index
                                    ? { ...r, roleId: e.target.value }
                                    : r,
                                ),
                              )
                            }
                          >
                            {roles
                              .filter(
                                (r) =>
                                  r.id === rule.roleId ||
                                  !rules.some((x) => x.roleId === r.id),
                              )
                              .map((r) => (
                                <option value={r.id} key={r.id}>
                                  {r.name}
                                </option>
                              ))}
                          </select>
                        </label>
                        <label>
                          Cấp truy cập
                          <select
                            value={rule.level}
                            onChange={(e) =>
                              setRules(
                                rules.map((r, i) =>
                                  i === index
                                    ? {
                                        ...r,
                                        level: e.target.value as Rule["level"],
                                        capabilities: [],
                                      }
                                    : r,
                                ),
                              )
                            }
                          >
                            <option value="viewer">Viewer</option>
                            <option value="operator">Operator</option>
                          </select>
                        </label>
                        <div className="permission-checks">
                          {[
                            ["group.write", "Sửa group"],
                            ["team.write", "Sửa team"],
                            ["audit.read", "Xem nhật ký"],
                          ].map(([cap, label]) => (
                            <label key={cap}>
                              <input
                                type="checkbox"
                                disabled={
                                  rule.level === "viewer" &&
                                  cap !== "audit.read"
                                }
                                checked={rule.capabilities.includes(cap)}
                                onChange={(e) =>
                                  setRules(
                                    rules.map((r, i) =>
                                      i === index
                                        ? {
                                            ...r,
                                            capabilities: e.target.checked
                                              ? [...r.capabilities, cap]
                                              : r.capabilities.filter(
                                                  (c) => c !== cap,
                                                ),
                                          }
                                        : r,
                                    ),
                                  )
                                }
                              />
                              {label}
                            </label>
                          ))}
                        </div>
                        <button
                          aria-label="Gỡ vai trò"
                          onClick={() =>
                            setRules(rules.filter((_, i) => i !== index))
                          }
                        >
                          <Trash2 size={17} />
                        </button>
                      </div>
                    ))
                  )}
                  {!listLoading && !rules.length && (
                    <Empty title="Chưa cấp quyền cho role nào">
                      Thêm role để cho phép Operator hoặc Viewer truy cập
                      dashboard.
                    </Empty>
                  )}
                  <div className="form-actions">
                    <button
                      className="button primary"
                      disabled={!available || listLoading}
                      onClick={() =>
                        void run(async () => {
                          await mutate("/settings", {
                            rules,
                            expected: settingsExpected,
                          });
                          setSettingsExpected(JSON.stringify(rules));
                          await loadSession();
                        })
                      }
                    >
                      <Check size={16} />
                      Lưu phân quyền
                    </button>
                  </div>
                </section>
              </>,
            )}
          <footer>
            <span>
              <AudioLines size={14} />
              CrossTalk <span>·</span> Voice administration
            </span>
            <span>
              <Clock3 size={12} />
              Cập nhật: {fmt(data?.updatedAt)}
              {offline ? " · Dữ liệu cũ" : ""}
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={18} />
          {toast}
          <button aria-label="Đóng thông báo" onClick={() => setToast("")}>
            <X size={15} />
          </button>
        </div>
      )}
      {modal && (
        <Modal
          title={
            modal.kind === "create-group"
              ? "Tạo Relay Group"
              : modal.kind === "rename"
                ? "Đổi tên group"
                : modal.kind === "create-team"
                  ? "Thêm team"
                  : modal.kind === "edit-team"
                    ? "Cập nhật team"
                    : modal.kind === "state"
                      ? modal.group!.state === "active"
                        ? "Tạm dừng group?"
                        : "Bật group?"
                      : modal.kind === "cancel-job"
                        ? "Hủy phần chưa xử lý?"
                        : "Xác nhận xóa"
          }
          description={
            modal.kind === "delete-group"
              ? `${modal.group!.name} và ${teams.filter((t) => t.groupId === modal.group!.id).length} team sẽ bị xóa. Bot được giải phóng; thành viên Discord không bị di chuyển.`
              : modal.kind === "delete-team"
                ? `${teamName(modal.team!)} sẽ ngừng relay và bot rời kênh. Thành viên Discord vẫn ở nguyên vị trí.`
                : modal.kind === "cancel-job"
                  ? "Request chuyển đang gửi sẽ được hoàn tất; các thành viên chưa xử lý sẽ được bỏ qua."
                  : modal.kind === "state"
                    ? "Chỉ group này bị ảnh hưởng. Kiểm tra kết nối thực tế sau thao tác."
                    : modal.kind === "edit-team"
                      ? "Pause các group liên quan trước khi đổi channel, group hoặc bot. Mapping team gốc được bảo vệ."
                      : "Thay đổi được lưu và đồng bộ với bot đang chạy."
          }
          close={() => {
            if (!busy) setModal(null);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const fields = new FormData(e.currentTarget);
              void run(async () => {
                const g = modal.group,
                  t = modal.team;
                if (modal.kind === "create-group")
                  await mutate("/groups", { name: fields.get("name") });
                if (modal.kind === "rename")
                  await mutate(`/groups/${g!.id}/rename`, {
                    name: fields.get("name"),
                    expected: g!.version,
                  });
                if (modal.kind === "delete-group")
                  await mutate(`/groups/${g!.id}/delete`, {
                    expected: g!.version,
                  });
                if (modal.kind === "state")
                  await mutate(`/groups/${g!.id}/state`, {
                    state: g!.state === "active" ? "paused" : "active",
                    expected: g!.version,
                  });
                if (modal.kind === "delete-team")
                  await mutate(`/teams/${t!.id}/delete`, {
                    expected: t!.version,
                  });
                if (modal.kind === "create-team")
                  await mutate("/teams", {
                    groupId: fields.get("groupId"),
                    channelId: fields.get("channelId"),
                    ...(fields.get("workerId")
                      ? { workerId: Number(fields.get("workerId")) }
                      : {}),
                  });
                if (modal.kind === "edit-team")
                  await mutate(`/teams/${t!.id}/update`, {
                    name: fields.get("name"),
                    groupId: fields.get("groupId") ?? t!.groupId,
                    channelId: fields.get("channelId") ?? t!.channelId,
                    workerId: Number(fields.get("workerId") ?? t!.workerId),
                    expected: t!.version,
                  });
                if (modal.kind === "cancel-job") {
                  await post(`/moves/${modal.job!.id}/cancel`, {});
                  setToast("Đã yêu cầu hủy phần chưa xử lý.");
                }
                setModal(null);
                await refresh();
              });
            }}
          >
            {["create-group", "rename", "edit-team"].includes(modal.kind) && (
              <label>
                Tên hiển thị
                <input
                  autoFocus
                  name="name"
                  maxLength={80}
                  defaultValue={modal.group?.name ?? modal.team?.name ?? ""}
                  placeholder={
                    modal.kind === "edit-team"
                      ? "Mặc định theo tên channel Discord"
                      : "Ví dụ: Bravo"
                  }
                  required={modal.kind !== "edit-team"}
                />
              </label>
            )}
            {["create-team", "edit-team"].includes(modal.kind) && (
              <>
                <label>
                  Relay Group
                  <select
                    name="groupId"
                    disabled={!!modal.team?.legacySlot}
                    defaultValue={modal.team?.groupId ?? groups[0]?.id}
                  >
                    {groups.map((g) => (
                      <option value={g.id} key={g.id}>
                        {g.name} ·{" "}
                        {g.state === "paused" ? "Tạm dừng" : "Hoạt động"}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Voice channel
                  <select
                    name="channelId"
                    disabled={!!modal.team?.legacySlot}
                    defaultValue={modal.team?.channelId ?? ""}
                    required
                  >
                    <option value="">Chọn voice channel</option>
                    {channels
                      .filter(
                        (c) =>
                          !teams.some(
                            (t) =>
                              t.channelId === c.id && t.id !== modal.team?.id,
                          ),
                      )
                      .map((c) => (
                        <option value={c.id} key={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Bot được phân công
                  <select
                    name="workerId"
                    disabled={!!modal.team?.legacySlot}
                    defaultValue={modal.team?.workerId ?? ""}
                  >
                    {modal.kind === "create-team" && (
                      <option value="">Tự chọn bot còn trống</option>
                    )}
                    {bots
                      .filter(
                        (b) =>
                          b.id === modal.team?.workerId ||
                          (!b.reserved && !b.teamId),
                      )
                      .map((b) => (
                        <option value={b.id} key={b.id}>
                          {b.name}
                        </option>
                      ))}
                  </select>
                </label>
              </>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="button subtle"
                disabled={busy}
                onClick={() => setModal(null)}
              >
                Quay lại
              </button>
              <button
                className={`button ${modal.kind.startsWith("delete") || modal.kind === "cancel-job" ? "danger" : "primary"}`}
                disabled={!available}
              >
                {busy
                  ? "Đang xử lý…"
                  : modal.kind.startsWith("delete")
                    ? "Xác nhận xóa"
                    : "Xác nhận"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
function SearchBox({
  value,
  set,
  placeholder,
}: {
  value: string;
  set: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="search-box">
      <Search size={16} />
      <input
        aria-label={placeholder}
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={placeholder}
      />
      {value && (
        <button type="button" aria-label="Xóa tìm kiếm" onClick={() => set("")}>
          <X size={14} />
        </button>
      )}
    </label>
  );
}
function Pager({
  page,
  more,
  set,
}: {
  page: number;
  more: boolean;
  set: (value: number) => void;
}) {
  return (
    <div className="pagination">
      <span>Trang {page + 1}</span>
      <button
        aria-label="Trang trước"
        disabled={page === 0}
        onClick={() => set(page - 1)}
      >
        <ChevronLeft size={16} />
      </button>
      <button
        aria-label="Trang sau"
        disabled={!more}
        onClick={() => set(page + 1)}
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
}
