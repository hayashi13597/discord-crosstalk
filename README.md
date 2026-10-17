# Discord CrossTalk Bot

Nhiều Discord bot account trong một ứng dụng Node.js + TypeScript, chạy trên một Railway service. Mỗi voice team có một bot và tối đa một leader. Chỉ giọng leader được chuyển sang các team khác **trong cùng relay group**; member nói nội bộ. Các group có router, mixer và queue riêng.

Bản nâng cấp khôi phục ba team hiện tại thành **Group A**, giữ nguyên channel, leader và bot 1–3. Thêm bot 4–6 để chạy Group B song song, tổng cộng sáu channel / 30 người theo kịch bản vận hành. Không áp dụng giới hạn số member bằng phần mềm.

## Chạy ở máy phát triển

Yêu cầu Node.js 24 LTS, npm và PostgreSQL:

```sh
docker compose up -d postgres
npm ci
cp .env.example .env
```

Điền ba token gốc, Guild ID, ba Voice Channel ID và `DATABASE_URL`, sau đó:

```sh
npm run build
npm start
```

Ứng dụng lấy instance lease, chạy migration có phiên bản trong transaction và khởi tạo Group A từ cấu hình cũ một lần. Những lần sau, group/team/leader và phân công worker được tải từ PostgreSQL; sửa `VOICE_CHANNEL_ID_1..3` không thay đổi team đã lưu. Cả ba leader ban đầu trống nếu chưa có dữ liệu cũ.

`npm run dev` chạy TypeScript. `npm run migrate` chỉ cập nhật schema; bước nhập Group A chạy khi ứng dụng khởi động. `npm run commands:register` đăng ký command riêng bằng Bot 1 sau khi build.

## Thiết lập Discord

1. Tạo ba bot application riêng cho Group A; thêm ba application cho Group B. Mời tất cả vào cùng server bằng scope `bot`. Bot 1 cần thêm `applications.commands`.
2. Cho từng bot quyền **View Channel**, **Connect**, **Speak** tại channel được phân công. Chừa một chỗ cho bot nếu channel giới hạn người. Không cần Administrator.
3. Sao chép Server ID và ba Voice Channel ID cũ bằng Developer Mode. Chỉ dùng regular voice channels, không dùng Stage.
4. Bot dùng `Guilds` và `GuildVoiceStates`, không cần Message Content hoặc Guild Members privileged intent. Không server mute/deafen bot.

Leader có thể được chỉ định trước khi vào voice. Relay chỉ bắt đầu khi group active và leader thực sự ở đúng channel. Người cùng channel nghe leader trực tiếp; bot không phát ngược giọng leader về nguồn.

## Slash commands

Chỉ Bot 1 đăng ký và xử lý commands. Gateway của Bot 1 vẫn hoạt động khi Group A paused hoặc team cũ số 1 đã được gỡ. Nếu gateway Bot 1 offline, commands tạm thời không khả dụng; các worker khác tiếp tục relay.

| Lệnh | Hành vi |
| --- | --- |
| `/group create name:Bravo` | Tạo group **paused** |
| `/group list` | Tên, số team và trạng thái groups |
| `/group info group:Bravo` | Teams, leaders, kết nối và lỗi của group |
| `/group pause group:Bravo` | Ngừng audio, rời voice; giữ cấu hình và worker đã phân công |
| `/group resume group:Bravo` | Bật group và kết nối lại workers |
| `/group delete group:Bravo` | Xác nhận rồi xóa group cùng teams/leaders; không cho xóa Group A |
| `/team add group:Bravo channel:<voice>` | Thêm team và giữ chỗ worker còn trống |
| `/team remove channel:<voice>` | Xác nhận rồi gỡ team và leader, giải phóng worker |
| `/team list group:Bravo` | Teams và trạng thái thuộc group |
| `/leader set channel:<voice> user:@Alice` | Gán/thay leader ngay sau khi ghi database thành công |
| `/leader remove channel:<voice>` | Xác nhận rồi ngừng relay leader; team vẫn nghe các leader cùng group |
| `/leader list group:Bravo` | Leaders của group; bỏ `group` để xem Group A như trước |
| `/leader show channel:<voice>` | Leader của một team |
| `/status` | Tổng quan PostgreSQL, groups và tất cả workers |

Các lệnh cũ `/leader set team:1 user:@Alice`, `/leader remove team:1`, `/leader show team:1` vẫn chọn đúng team gốc của Group A. Chọn **một** trong `team` hoặc `channel`. Nếu team gốc đã bị gỡ, số cũ báo không còn tồn tại và không được cấp lại cho team khác. Worker 1–3 được giữ cho các team gốc, kể cả khi team đó đã gỡ.

Group được chọn từ autocomplete theo tên, truyền ID ổn định. Tên group dài 1–80 ký tự, duy nhất trong server, không phân biệt hoa/thường. Một channel chỉ thuộc một team; một worker chỉ phục vụ một channel; một người chỉ làm leader của một team trong server. Không chọn bot hoặc user ngoài server làm leader.

Tất cả phản hồi ephemeral bằng tiếng Việt; kết quả dài có nút chuyển trang. Thành viên được dùng lệnh xem. Mutation yêu cầu **Manage Server / Manage Guild** (bao gồm Administrator) hoặc role trong `ADMIN_ROLE_IDS`; ứng dụng fetch lại quyền mỗi lần thay đổi. Xóa group/team/leader yêu cầu nút xác nhận trong **60 giây**, chỉ người chạy lệnh được xác nhận. Quyền và cấu hình mục tiêu được kiểm tra lại; nếu cấu hình đã đổi, chạy lại lệnh.

## Cấu hình và dữ liệu

| Biến | Yêu cầu / mặc định |
| --- | --- |
| `BOT_TOKEN_1`, `BOT_TOKEN_2`, `BOT_TOKEN_3` | Ba token gốc, bắt buộc và khác nhau |
| `BOT_TOKEN_4`, `BOT_TOKEN_5`, `BOT_TOKEN_6` | Thêm để có ba worker cho Group B; không bắt buộc nếu chỉ chạy A |
| `BOT_TOKEN_n` với n > 6 | Tùy chọn để mở rộng pool workers |
| `GUILD_ID` | Server Discord duy nhất |
| `VOICE_CHANNEL_ID_1..3` | Ba channel gốc, bắt buộc; chỉ nhập vào Group A khi khởi tạo lần đầu |
| `DATABASE_URL` | PostgreSQL URL, dùng kết nối trực tiếp với session ổn định |
| `ADMIN_ROLE_IDS` | Danh sách role ID phân cách bằng dấu phẩy, tùy chọn |
| `JITTER_BUFFER_MS` | `60`; bội số 20, từ 0 đến 500, nhỏ hơn `MAX_QUEUE_MS` |
| `MAX_QUEUE_MS` | `200`; bội số 20, từ 20 đến 1000 |
| `SINGLE_SOURCE_GAIN` | `1`; từ 0 đến 2 |
| `MIX_SOURCE_GAIN` | `0.5` cho mỗi nguồn khi trộn nhiều nguồn; từ 0 đến 1 |
| `LOG_LEVEL` | `info`; fatal/error/warn/info/debug/trace/silent |

Không cần `VOICE_CHANNEL_ID_4..6`: thêm channel mới bằng `/team add`. Không đặt leader ID trong biến môi trường. Token chỉ nằm trong môi trường bí mật, không vào database, phản hồi hoặc log.

Database lưu ID group/team, trạng thái active/paused, channel, leader, khóa worker và Discord Bot User ID đã xác minh. Khóa worker là số `n` trong `BOT_TOKEN_n`; **không đổi số khóa giữa các account**. Có thể rotate token của cùng account. Đổi sang một account khác tại khóa đã lưu sẽ báo `BOT_IDENTITY_CONFLICT`, không cho account đó relay.

Team paused vẫn giữ chỗ worker. Khi thiếu token đã phân công, ứng dụng hiển thị lỗi riêng của team và không lấy worker khác thay thế. Thêm team khi hết worker bị từ chối; resume group bị từ chối nếu thiếu token. Workers 1–3 không được cấp cho team mới.

Migration `002` thêm các bảng `relay_*`, giữ nguyên `leader_assignments` và `leader_audit`. Các thay đổi leader của team gốc được ghi vào cả hai mô hình trong cùng transaction để hỗ trợ rollback. Audit lưu thay đổi cấu hình và người thao tác; không ghi âm thanh. Trước COMMIT, lỗi mutation giữ nguyên cấu hình đang chạy. Nếu không xác định được kết quả COMMIT cấu hình hoặc mất instance lease, ứng dụng dừng relay và thoát để tải lại trạng thái bền vững.

## Audio và khôi phục kết nối

- Mỗi group có một `AudioRouter`, timer, queue và snapshot leader riêng. Chỉ subscribe leader không phải bot ở đúng channel; giọng member và mọi relay bot bị bỏ qua.
- Giữ engine Opus → PCM stereo signed 16-bit little-endian 48 kHz, frame 20 ms, jitter ngắn, queue có giới hạn và bỏ backlog sau event loop stall. Không ghi âm.
- Mỗi đích trộn tất cả nguồn khác trong cùng group, không ưu tiên người nói trước. Một nguồn dùng gain 1; nhiều nguồn dùng gain 0,5 mỗi nguồn theo cấu hình, giới hạn sample chống clipping. Với ba team, mỗi đích có tối đa hai nguồn.
- Đổi/gỡ leader vô hiệu hóa epoch/callback cũ và reset output trong đúng group để bỏ audio đang chờ. Audio đã gửi tới Discord hoặc thiết bị vẫn có độ trễ ngắn.
- Pause đóng capture, queue, output và voice connection của group; resume không phát audio cũ. Reconnect từng worker độc lập, exponential backoff kèm jitter tối đa 30 giây. Bot bị move/kick sẽ về channel được lưu.
- `/status` báo `MISSING_VOICE_PERMISSIONS`, `INVALID_VOICE_CHANNEL`, `BOT_IDENTITY_CONFLICT` hoặc mã lỗi an toàn. Group bị lỗi mixer ngừng riêng; dùng pause/resume để thử lại. Các group dùng chung process vẫn cùng chịu lỗi process, database lease hoặc thiếu tài nguyên toàn máy.
- Ưu tiên native `@discordjs/opus`; fallback `opusscript` khi thiếu native binary. Không cần FFmpeg. Nhận audio từ Discord cần nghiệm thu trên server thật khi nâng phiên bản thư viện hoặc trước phiên vận hành quan trọng.

## Railway và nâng cấp từ bản ba team

Giữ một service bot cùng PostgreSQL bền vững. `railway.toml` đã đặt một replica, tắt sleep, `overlapSeconds=0` và thời gian drain 15 giây. Không bật nhiều region/replica hoặc HTTP healthcheck cho worker này. Instance lease PostgreSQL ngăn hai process điều khiển cùng bộ bot. Không dùng PgBouncer transaction pooling cho `DATABASE_URL`.

1. **Sao lưu PostgreSQL trước nâng cấp**, lưu cấu hình channel/token gốc và commit/image của phiên bản đang chạy. Dùng `pg_dump` với định dạng custom; thử khả năng khôi phục trên database riêng.
2. Redeploy bản mới với các biến cũ. Có một khoảng gián đoạn khi restart. Kiểm tra Group A có đúng ba channel, leader và worker 1–3; nghiệm thu relay của A trước khi bật B.
3. Mời ba bot mới vào Discord và thêm `BOT_TOKEN_4..6` bằng Railway Variables, giữ nguyên token 1–3. Redeploy để tải worker mới; kiểm tra lại Group A.
4. Chạy `/group create name:Bravo`, thêm ba channel qua `/team add group:Bravo channel:...`. Group vẫn paused, các worker 4–6 đã được giữ chỗ.
5. Gán leaders bằng `/leader set channel:... user:...`, kiểm tra `/group info`, rồi `/group resume group:Bravo`.
6. Chạy các kịch bản nghiệm thu bên dưới. Theo dõi CPU/RAM/network khi sáu leaders nói đồng thời và trong phiên 30 người đủ dài.

Dừng bằng SIGTERM/SIGINT đóng capture, players, Discord connections và PostgreSQL. Docker dùng Node.js 24, build native Opus bằng toolchain và chạy bằng user `node` ở runtime. Dữ liệu nằm trong PostgreSQL; service bot không cần volume riêng.

## Rollback

- Nếu B gặp lỗi: `/group pause group:Bravo`; xác nhận A tiếp tục relay. Cách này giữ nguyên bản mới và cấu hình B để sửa sau.
- Nếu cần quay về mã cũ: pause B, dừng instance mới hoàn toàn, redeploy commit/image cũ với token/channel 1–3 ban đầu và cùng database. Bản cũ bỏ qua schema mới; leader A đã được ghi đồng thời vào các bảng cũ. Không chạy hai bản đồng thời.
- Để quay về toàn bộ dữ liệu trước nâng cấp, dừng bot và phục hồi bản sao lưu vào database riêng rồi đổi `DATABASE_URL`. Việc khôi phục sẽ bỏ các thay đổi sau thời điểm sao lưu.
- Nếu đã chạy mã cũ và sửa leader sau rollback, trước khi nâng cấp lại hãy đối chiếu/import các thay đổi đó vào mô hình mới trong thời gian bảo trì. Khởi động bản mới không tự nhập lại các bảng cũ vì có thể làm sống lại team đã gỡ.

## Kiểm thử và nghiệm thu

```sh
npm run check
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/crosstalk_test npm run test:integration
```

`npm run check` gồm typecheck, unit/mocked lifecycle, codec thật và build. Có `TEST_DATABASE_URL` thì toàn bộ integration tests cũng chạy. Integration tạo/xóa schema ngẫu nhiên, cần quyền tạo schema; dùng database test riêng. CI dùng PostgreSQL 17 và build Docker image.

Tự động kiểm tra migration từ schema cũ, mapping bền vững, cấp worker đồng thời, ràng buộc dữ liệu, rollback transaction, bảng leader tương thích bản cũ, quyền/xác nhận command, epoch và audio hai group. Các kiểm tra này không thay thế thử voice thực tế theo AC-01–AC-15 trong đặc tả:

- A hoạt động như cũ trước khi resume B; từng leader chỉ tới hai team khác cùng group, không vọng về nguồn và không sang group kia.
- Member và bot không được relay. Hai/ba leaders mỗi group, rồi cả sáu leaders nói đồng thời đều nghe đủ nguồn trong đúng group.
- Đổi/gỡ leader, leader rời/vào channel, pause/resume B: không phát audio cũ, A tiếp tục hoạt động.
- Thử channel trùng, hết worker, thiếu quyền voice, bot B bị kick/move/mất kết nối: báo lỗi riêng và khôi phục đúng mapping.
- Restart/redeploy giữ groups, leaders, trạng thái paused và bot assignments. Thử rollback trên database sao chép trước khi dùng production.

Chưa bao gồm dashboard, nhiều server, ghi âm, tự chia team hoặc điều phối nhiều service. Không có Discord token production được cấu hình sẵn trong repository; chỉ xác nhận nghiệm thu voice/Railway sau khi thực sự chạy các bước này.
