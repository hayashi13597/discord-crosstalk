# Discord CrossTalk Bot

Ba bot account trong một ứng dụng Node.js + TypeScript, chạy trên một Railway service. Mỗi bot ở một voice channel cố định trong cùng server. Leader nói tự nhiên; hai team khác nghe qua bot. Member chỉ nói nội bộ.

## Chạy ở máy phát triển

Yêu cầu Node.js 24 LTS, npm và PostgreSQL. Có thể dùng PostgreSQL có sẵn hoặc khởi động database cục bộ:

```sh
docker compose up -d postgres
npm ci
cp .env.example .env
```

Điền ba token, Guild ID, ba Voice Channel ID và `DATABASE_URL` trong `.env`, sau đó:

```sh
npm run build
npm start
```

Ứng dụng tự chạy migration, tải leader từ PostgreSQL và đăng ký guild slash commands trên **Bot Team 1**. Lần đầu cả ba team chưa có leader. `npm run dev` chạy trực tiếp TypeScript; `npm run migrate` và `npm run commands:register` dùng bản đã build khi cần thao tác riêng.

## Thiết lập Discord

1. Tạo ba application/bot riêng tại [Discord Developer Portal](https://discord.com/developers/applications), lấy ba bot token khác nhau.
2. Mời cả ba vào cùng server bằng scope `bot`; Bot Team 1 cần thêm `applications.commands` để cung cấp lệnh.
3. Trong voice channel tương ứng, cho mỗi bot quyền **View Channel**, **Connect**, **Speak**. Không cần Administrator. Nếu channel có giới hạn người, chừa một chỗ cho bot.
4. Bật Developer Mode của Discord để sao chép Server ID và ba Voice Channel ID. Dùng regular voice channels, không dùng Stage channels.
5. Ứng dụng chỉ bật gateway intents `Guilds` và `GuildVoiceStates`; không yêu cầu Message Content hoặc Guild Members privileged intent.

Bot join với `selfDeaf=false`, `selfMute=false`; không server mute/deafen bot. Leader được phép chỉ định trước khi vào voice, nhưng chỉ được relay khi ở đúng channel đã cấu hình. Thông báo cho người tham gia rằng giọng leader sẽ được chuyển sang các team khác.

## Slash commands

| Lệnh | Hành vi |
| --- | --- |
| `/leader set team:1 user:@Alice` | Gán/thay leader của team; quyền cũ bị thu hồi khi lệnh thành công |
| `/leader remove team:1` | Ngừng relay leader của team; team vẫn nghe leader bên ngoài |
| `/leader list` | Hiển thị leader của cả ba team, bao gồm team trống |
| `/leader show team:1` | Xem một team |
| `/status` | Trạng thái PostgreSQL, gateway/voice, channel thực tế, leader và điều kiện relay |

Tất cả phản hồi là ephemeral, bằng tiếng Việt. Thành viên server được dùng lệnh xem. Thêm/thay/xóa leader yêu cầu **Manage Server / Manage Guild** (Administrator cũng hợp lệ) hoặc một role trong `ADMIN_ROLE_IDS`. Bot fetch lại quyền người thao tác tại mỗi lần thay đổi. Một tài khoản chỉ được làm leader của một team; không thể chọn bot hoặc user ngoài server.

Chỉ Bot Team 1 đăng ký và xử lý lệnh, tránh ba bộ command trùng nhau. Nếu Bot 1 mất gateway, lệnh tạm thời không khả dụng; relay giữa hai bot còn kết nối vẫn tiếp tục.

## Cấu hình

| Biến | Bắt buộc / mặc định |
| --- | --- |
| `BOT_TOKEN_1`, `BOT_TOKEN_2`, `BOT_TOKEN_3` | Ba bot token khác nhau |
| `GUILD_ID` | Server Discord duy nhất |
| `VOICE_CHANNEL_ID_1`, `VOICE_CHANNEL_ID_2`, `VOICE_CHANNEL_ID_3` | Ba voice channel khác nhau trong server |
| `DATABASE_URL` | PostgreSQL connection string; dùng kết nối trực tiếp có session ổn định |
| `ADMIN_ROLE_IDS` | Tùy chọn, danh sách role ID cách nhau bằng dấu phẩy |
| `JITTER_BUFFER_MS` | `60`; bội số 20, từ 0 đến 500, nhỏ hơn `MAX_QUEUE_MS` |
| `MAX_QUEUE_MS` | `200`; bội số 20, từ 20 đến 1000 |
| `SINGLE_SOURCE_GAIN` | `1`; từ 0 đến 2 |
| `MIX_SOURCE_GAIN` | `0.5` cho mỗi nguồn khi trộn hai nguồn; từ 0 đến 1 |
| `LOG_LEVEL` | `info`; hỗ trợ fatal/error/warn/info/debug/trace/silent |

Leader ID chỉ nằm trong PostgreSQL, không có biến môi trường leader. Hai bảng nghiệp vụ là `leader_assignments` và `leader_audit`; schema migration có phiên bản và tự chạy trong transaction. Audit ghi người cũ/mới, team, người thao tác và thời điểm, không ghi âm thanh.

## Cách audio hoạt động

- Mỗi bot có voice connection group riêng theo Bot User ID, receiver và player riêng. Chỉ subscribe User ID leader hợp lệ ở đúng channel; bỏ qua member và mọi bot account.
- Giải mã Opus thành PCM stereo signed 16-bit little-endian, 48 kHz; xử lý frame 20 ms. Mỗi nguồn có queue ngắn, bỏ frame cũ hoặc tràn queue. Không phát bù backlog khi event loop bị chậm.
- Mỗi đích chỉ trộn hai nguồn bên ngoài. Một nguồn dùng gain 1; hai nguồn dùng gain 0,5 mỗi nguồn, kèm giới hạn sample chống clipping. Nguồn thiếu dữ liệu đóng góp silence. Không đưa audio của kênh nguồn trở lại chính kênh đó.
- Gói Opus đầu ra chỉ đệm tối đa một packet. Khi thu hồi quyền, xóa nguồn, vô hiệu hóa callback cũ và tạo lại resource/encoder tại hai đích để loại cả audio đã trộn đang chờ phát. Audio đã gửi tới Discord hoặc thiết bị người nghe vẫn có thể còn một khoảng trễ ngắn.
- Ưu tiên native `@discordjs/opus` (optional dependency); tự dùng Opus WASM `opusscript` nếu không có native binary. Luồng PCM/Opus này không cần FFmpeg. Đo CPU và chất lượng khi cả ba leader nói trước khi dùng chính thức.
- DAVE do `@discordjs/voice` và dependency `@snazzah/davey` xử lý. Thư viện [lưu ý rằng nhận audio không có bảo đảm ổn định từ Discord](https://discordjs.dev/docs/packages/voice/main); phải thử trên Discord thật khi nâng phiên bản hoặc trước đợt vận hành quan trọng.

Không có bản ghi âm; audio chỉ tồn tại trong bộ nhớ. Chưa hỗ trợ dashboard, nhiều server, tự chia team, giới hạn số member hay khử vọng do micro/loa của người dùng.

## Railway

1. Tạo một project, thêm **PostgreSQL** và một service từ repository này. Railway dùng `Dockerfile` và `railway.toml`.
2. Thêm các biến trong `.env.example` vào service bot. Gán `DATABASE_URL` bằng reference tới database, ví dụ `${{Postgres.DATABASE_URL}}` (đổi `Postgres` theo tên service thực tế). Không đưa `.env` vào repository/image.
3. Chạy **một replica, một region**, tắt Serverless/App Sleeping. Không tạo public domain hoặc HTTP healthcheck cho worker này. Không cần Volume riêng trên service bot; dữ liệu nằm ở PostgreSQL.
4. Kiểm tra log migration, dependency report, đăng ký commands và ba voice connection chuyển sang `ready`. Gán leader rồi chạy `/status`.
5. Khi redeploy, có thể có gián đoạn ngắn. `overlapSeconds=0` và khoảng dừng 15 giây được đặt theo [cấu hình teardown Railway](https://docs.railway.com/config-as-code/reference#deployment-teardown). PostgreSQL advisory lock ngăn instance mới điều khiển bot khi instance cũ còn giữ lease; instance trùng thoát lỗi để Railway retry. Không bật nhiều region hoặc replica cho bộ bot này.

Docker dùng Node.js 24 trên Debian, có toolchain ở build stage để biên dịch native Opus khi cần, và chạy bằng user `node` ở runtime. Dừng bằng `SIGTERM`/`SIGINT` sẽ đóng capture, player, kết nối Discord và PostgreSQL. Mất lease database hoặc không xác định được kết quả COMMIT khiến ứng dụng ngừng relay và thoát lỗi để tải lại trạng thái bền vững khi khởi động lại. Không dùng PgBouncer transaction pooling cho `DATABASE_URL` vì instance lease cần session PostgreSQL cố định.

Mỗi bot retry kết nối độc lập, exponential backoff kèm jitter tới tối đa 30 giây. Nếu bot bị move/kick, nó trở về channel được phân công. Bot mất kết nối sẽ hủy nguồn/buffer liên quan; hai bot còn lại vẫn relay an toàn cho nhau. `/status` hiển thị mã lỗi an toàn gần nhất; log chi tiết có che token và database password. Không có cam kết độ trễ, chi phí hoặc tài nguyên cố định.

## Kiểm thử và nghiệm thu

```sh
npm run check
```

Bao gồm typecheck, unit/mocked lifecycle tests, smoke test codec Opus và build. Integration tests PostgreSQL được bật bằng database test riêng:

```sh
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/crosstalk npm run test:integration
```

Mỗi lần chạy tạo/xóa một schema ngẫu nhiên; tài khoản test cần quyền tạo schema. Không trỏ biến test vào database production. CI chạy toàn bộ test với PostgreSQL 17 và build Docker image.

Kiểm thử tự động xác nhận logic routing và lifecycle; không thay thế thử voice thật. Làm lần lượt các bước sau trên Discord/Railway:

- Ba bot vào đúng ba channel. Gán ba leader; từng leader nói và chỉ hai bot bên ngoài phát tiếng.
- Member nói ở mỗi team: hai team khác không nghe. Thử gán bot, user không thuộc server, user đã làm leader team khác và thao tác từ người không có quyền: đều bị từ chối.
- Hai rồi ba leader nói đồng thời: nghe đủ các nguồn, không phát lại về nguồn, không vòng lặp, không clipping rõ rệt.
- Thay/xóa leader khi đang nói: ngừng giọng cũ, nguồn mới hoạt động ngay khi ở đúng channel; team không có leader vẫn nghe bên ngoài.
- Leader rời/vào lại, bot bị kick/move, mất voice tạm thời: relay phục hồi đúng channel, không phát âm thanh cũ. Xem `/status` khi thiếu quyền hoặc server mute/deafen.
- Restart/redeploy: giữ phân công và audit. Dừng service: bot rời voice, không tạo file ghi âm. Quan sát CPU/RAM, độ rõ và độ trễ trong một phiên chơi đủ dài với 15 người.

Không có Discord token hoặc database test được cấu hình sẵn trong repository. Chỉ xác nhận nghiệm thu voice và triển khai sau khi các bước thực tế này đã chạy thành công.
