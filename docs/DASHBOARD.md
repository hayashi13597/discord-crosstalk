# CrossTalk Dashboard

Dashboard tiếng Việt, dark theme, Next.js App Router; chạy tách khỏi voice worker trên Railway. Các dependency stable được khóa trong `dashboard/package-lock.json` (Next.js 16.4.2 / React 19.3.1 tại thời điểm triển khai).

## Tính năng và tương thích

| Chức năng | Bot hiện tại | Dashboard |
| --- | --- | --- |
| Guild | Một `GUILD_ID` | Cùng guild, kiểm tra membership/quyền |
| Groups | Create/list/pause/resume/delete | Thêm rename, tìm kiếm, desired/actual state |
| Teams | Add/remove/list, tự phân worker | Thêm tên hiển thị, chọn worker trống, sửa mapping khi paused |
| Leaders | Role Leader, nhiều leader/team | Chỉ xem runtime, không gán thủ công |
| Mass Move | Tối đa 25 nguồn trong select, snapshot khi confirm | Checkbox không giới hạn cố định 25, preview snapshot hết hạn sau 60 giây |
| Move execution | Một service/job mỗi guild, dừng khi lỗi | Cùng service/khóa DB, thêm hủy phần chưa xử lý |
| Quyền | Manage Guild hoặc ADMIN_ROLE_IDS cho relay | Thêm role Operator/Viewer; dùng chung kiểm tra mutation với slash commands |
| Activity | Relay audit và move jobs | Lọc theo actor/hành động/group/thời gian; trạng thái bot và Settings audit |
| Bot reconnect | Tự khôi phục theo engine | Hiển thị trạng thái, chưa thêm reconnect thủ công |

Không thay đổi engine Opus/mixer/capture. Worker 1–3 tiếp tục dành cho mapping gốc. Group A không được xóa. Team gốc được sửa tên hoặc xóa theo luồng xác nhận; không đổi mapping channel/group/worker của team gốc. Thay đổi mapping team khác yêu cầu cả group nguồn/đích paused; tên hiển thị không yêu cầu pause.

Leaders lấy từ `leaderIds`/`leadersKnown` runtime. Không coi leader chưa xác minh là danh sách rỗng. Role thay đổi trên Discord được phản ánh khi runtime nhận sự kiện, không cần restart. Các cột leader cũ vẫn được giữ để rollback.

## Kiến trúc và quyền

```text
Browser ─HTTPS─> Next.js UI / API / Discord OAuth
                         │          │
                         │          └── PostgreSQL (sessions/audit)
                         │ authenticated private HTTP
                         ▼
                    Worker Control API
                         │
                RelayService / VoiceMoveService
                         │
                 Discord clients / voice engine
```

Worker giữ bot tokens. Dashboard giữ OAuth client secret, session secret, encryption key và control secret; không cần bot token. Không đăng nhập thêm Discord client ở dashboard. Control API tắt nếu `WORKER_CONTROL_SECRET` chưa được cấu hình, nên deployment bot cũ vẫn chạy khi chưa triển khai UI.

- Manage Guild/Administrator: quản trị dashboard, sửa Settings. Mass Move còn cần Move Members (Administrator có semantics Discord tương ứng).
- `ADMIN_ROLE_IDS`: sửa groups/teams như trước; không cấp Settings hoặc Mass Move.
- Operator: chỉ những capability được Admin cấp: `group.write`, `team.write`, `audit.read`.
- Viewer: đọc trạng thái; tùy chọn `audit.read`. Không thay đổi cấu hình.
- Quyền mutation được fetch lại từ Discord và DB. Quyền đọc được cache tối đa 15 giây; sửa Settings xóa cache ngay. Session kiểm tra lại qua DB cho mỗi request/chu kỳ SSE.
- Không có quyền được chỉ dẫn cấp quyền từ UI. Ban đầu người có Manage Guild đăng nhập để cấp role trong Settings.

Mọi request Control API phải có `Authorization: Bearer <WORKER_CONTROL_SECRET>` và `X-Actor-Id`. Đây là giao diện tin cậy giữa server; không mở public domain hoặc chuyển secret xuống browser. Secret tối thiểu 32 byte, nên sinh bằng `openssl rand -hex 32`.

## Chạy local

1. Chuẩn bị PostgreSQL và cấu hình `.env` worker như README chính, thêm `WORKER_CONTROL_SECRET`, `WORKER_CONTROL_PORT=3100`.
2. `npm ci && npm run build && npm run migrate` ở root. Migration 004 bổ sung bảng dashboard; không xóa dữ liệu cũ.
3. Chạy worker bằng `npm run dev`. Chỉ dùng test bot/guild khi phát triển.
4. Trong `dashboard/`: `npm ci`, sao chép `.env.example` thành `.env.local`, điền cấu hình và chạy `npm run dev`.
5. Đăng ký redirect `http://localhost:3000/api/auth/discord/callback` trong Discord Developer Portal → OAuth2 → Redirects.

| Biến dashboard | Nội dung |
| --- | --- |
| `APP_URL` | Origin của dashboard; local `http://localhost:3000`, production HTTPS |
| `DATABASE_URL` | PostgreSQL đã chạy migration 004 |
| `DISCORD_CLIENT_ID` | Application ID dùng cho OAuth, có thể cùng application Bot 1 |
| `DISCORD_CLIENT_SECRET` | OAuth client secret, không phải bot token |
| `DISCORD_REDIRECT_URI` | URL callback đầy đủ, khớp chính xác Developer Portal |
| `SESSION_SECRET` | Secret ngẫu nhiên độc lập, tối thiểu 32 ký tự |
| `TOKEN_ENCRYPTION_KEY` | 64 ký tự hex, khóa AES-256-GCM cho OAuth tokens |
| `WORKER_CONTROL_URL` | Origin worker: local `http://localhost:3100`; production private domain |
| `WORKER_CONTROL_SECRET` | Cùng secret với worker |

Sinh riêng mỗi secret/key bằng `openssl rand -hex 32`. Không dùng token production trong test. OAuth scope `identify guilds`; membership/quyền guild được kiểm tra bởi worker. Bot không cần thêm Manage Roles vì Leaders chỉ xem.

Session tồn tại 7 ngày, cookie HttpOnly/SameSite=Lax, Secure trong production. Session token có chữ ký và chỉ lưu hash trong DB. OAuth state dùng một lần, 10 phút. Mutation yêu cầu cùng Origin với APP_URL và CSRF token của session. Logout thu hồi session local; các session khác không bị ảnh hưởng. Session/OAuth state hết hạn được dọn lúc bắt đầu đăng nhập.

## Railway: hai service cùng repository

**Worker hiện có**

- Root Directory: `/`; Config File: `/railway.toml`; Dockerfile root.
- Giữ một replica, không sleep, không overlap; không thêm HTTP healthcheck vào worker.
- Thêm `WORKER_CONTROL_SECRET` và `WORKER_CONTROL_PORT=3100`.
- Không generate public domain/TCP proxy cho cổng Control API.
- Watch paths đã cấu hình chỉ cho source/migrations/dependency/build files của worker.

**Dashboard mới**

1. Trong cùng project/environment → New service → cùng GitHub repository.
2. Đặt Root Directory `/dashboard`, Railway Config File `/dashboard/railway.toml`. Dockerfile `Dockerfile` được build với context là thư mục dashboard.
3. Thêm các biến ở bảng trên. `DATABASE_URL` tham chiếu `${{Postgres.DATABASE_URL}}` theo tên service database thực tế.
4. `WORKER_CONTROL_URL=http://${{voice-worker.RAILWAY_PRIVATE_DOMAIN}}:3100` — thay `voice-worker` bằng đúng tên service bot. Domain riêng chỉ dùng ở phía server.
5. Build rồi Generate Domain; đặt APP_URL và redirect URI theo HTTPS domain này, thêm redirect vào Discord Developer Portal và deploy cấu hình.
6. Healthcheck `/api/health` kiểm tra web process, độc lập với tình trạng voice worker. Docker chạy `node server.js` với PORT do Railway cấp, bind `0.0.0.0`.
7. Watch paths `/dashboard/**` để UI deploy độc lập với bot.

SSE qua `/api/events`, tự reconnect sau khoảng 55 giây; fallback polling mỗi 5 giây. SSE không giữ job sống. Không dùng static export: OAuth/session/API cần Node server. Worker bind dual-stack `::` cho private network.

## API, trạng thái và xử lý lỗi

Browser: `/api/auth/discord/login`, `/api/auth/discord/callback`, `/api/auth/logout`, `/api/session`, `/api/events`, `/api/control/*`.

Control prefix `/internal/v1`:

- GET `access`, `snapshot`, `settings`, `audit`, `moves`, `moves/:id`, `operations/:id`.
- POST `groups`, `groups/:id/rename|state|delete`, `teams`, `teams/:id/update|delete`, `settings`.
- POST `moves/preview`, `moves/confirm`, `moves/:id/cancel`.

Config POST dùng UUID `Idempotency-Key`. Cùng key/cùng payload trả operation cũ; khác payload bị 409. Mutation mục tiêu nhận `expected` version từ snapshot. Operation có Pending/Applied/Failed/Unknown. Applied nghĩa cấu hình đã commit; actual state vẫn có thể Degraded hoặc Offline. Timeout không đồng nghĩa thất bại: UI giữ operation ID trong sessionStorage để kiểm tra; không tự gửi lại bằng key mới. Sau worker restart, operation Pending được đánh Unknown, không tự thực thi lại.

Worker offline hoặc chưa xác minh được quyền: API fail closed, UI đánh dấu dữ liệu cũ và khóa mutation. Dữ liệu lịch sử không được mở qua một đường bỏ qua phân quyền khi worker offline. Tắt dashboard không ngắt voice worker.

Mass Move preview chụp snapshot ở worker, gắn actor/guild và hết hạn sau 60 giây. Confirm chỉ gửi preview ID; worker kiểm tra lại quyền và điều kiện, dùng ID đó làm job ID. Chỉ trả accepted sau khi job đã commit. Tối đa một job/guild cho cả slash/web; duplicate confirm không tạo job mới. Cancel chờ request đang gửi hoàn tất, bỏ qua phần chưa xử lý; không rollback. Lỗi 429/5xx/timeout tuân thủ chính sách fail-stop hiện tại; request chưa rõ kết quả không được gửi lại. Worker restart phục hồi Interrupted/unknown như trước.

Audit relay có before/after; dashboard audit Settings, yêu cầu cancel và thay đổi trạng thái gateway/voice/error (kiểm tra 5 giây). Không ghi audio, tokens, OAuth secrets hoặc nội dung hội thoại. Nhật ký bot là chuyển trạng thái quan sát được, không phải tracing từng sự kiện mạng. Move jobs giữ retention 90 ngày như hiện tại.

## Kiểm thử

```sh
# Root — dùng database test riêng, tests tạo schema riêng
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/crosstalk_test npm run check

# Dashboard
cd dashboard
npm ci
npm run check
npx playwright install --with-deps chromium
npm run test:e2e
```

Browser tests giả lập Discord/worker tại lớp HTTP của trình duyệt, không thêm chế độ bypass production. Kiểm tra login UI, desktop/mobile, mutation, Leaders chỉ đọc, trên 25 nguồn, preview/confirm, Viewer và worker offline. Unit tests kiểm tra OAuth state replay, session hết hạn, CSRF, mã hóa credential, quyền và Control API. PostgreSQL integration kiểm tra migration, idempotency cạnh tranh, optimistic concurrency và job persistence/cancel.

CI build Docker của cả worker và dashboard. Các kiểm tra này không thay thế nghiệm thu Discord: test Group A và hai group độc lập, thay đổi role, đầy đích, Discord disconnect, restart giữa job và tắt dashboard. Ghi nhận kết quả thực tế trước production.

## Rollout, backup và rollback

1. Lưu commit/image đang chạy và sao lưu DB (`pg_dump -Fc`), thử restore trên DB riêng. Không ghi secrets vào Git/log.
2. Deploy worker trước: migration 004 additive, Control API và quyền mới. Worker restart có gián đoạn voice; kiểm tra Group A trước thao tác khác.
3. Deploy dashboard; kiểm tra OAuth, Viewer/Operator/Admin và trạng thái thực tế. Test mutation trên group test trước.
4. Theo dõi Railway CPU/RAM, gateway/voice status, HTTP 401/403/429/503 và operation Unknown. Không tăng replica worker.
5. Rollback dashboard độc lập bằng image/commit cũ hoặc dừng dashboard. Voice vẫn chạy.
6. Rollback worker: dừng instance mới hoàn toàn rồi deploy bản cũ; không chạy song song cùng tokens. Không drop migration 004 khi rollback. Nếu phải phục hồi DB, dừng worker và restore vào DB riêng trước khi đổi DATABASE_URL.

Rotate SESSION_SECRET sẽ buộc đăng nhập lại. TOKEN_ENCRYPTION_KEY cần giữ ổn định để đọc các credential đã lưu; khi thay key hãy xóa session cũ theo quy trình vận hành. Rotate control secret ở cả hai service trong cùng đợt cấu hình; khoảng lệch secret sẽ khóa dashboard API nhưng không dừng relay.
