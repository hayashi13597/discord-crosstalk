# Discord CrossTalk Bot

Nhiều Discord bot account trong một ứng dụng Node.js + TypeScript, chạy trên một Railway service. Mỗi voice team có một bot và có thể có nhiều leader. Mọi thành viên không phải bot có role `LEADER_ROLE_ID` trong voice channel của team đều là leader; không gán từng người bằng lệnh. Chỉ giọng leader được chuyển sang các team khác **trong cùng relay group**; member nói nội bộ. Các group có router, mixer và queue riêng.

Bản nâng cấp khôi phục ba team hiện tại thành **Group A**, giữ nguyên channel và bot 1–3. Phân công leader cũ được giữ trong database để rollback nhưng không còn cấp quyền relay. Thêm bot 4–6 để chạy Group B song song, tổng cộng sáu channel / 30 người theo kịch bản vận hành. Không áp dụng giới hạn số member bằng phần mềm.

## Chạy ở máy phát triển

Yêu cầu Node.js 24 LTS, npm và PostgreSQL:

```sh
docker compose up -d postgres
npm ci
cp .env.example .env
```

Điền ba token gốc, Guild ID, ba Voice Channel ID, `LEADER_ROLE_ID` và `DATABASE_URL`, sau đó:

```sh
npm run build
npm start
```

Ứng dụng lấy instance lease, chạy migration có phiên bản trong transaction và khởi tạo Group A từ cấu hình cũ một lần. Những lần sau, group/team và phân công worker được tải từ PostgreSQL; sửa `VOICE_CHANNEL_ID_1..3` không thay đổi team đã lưu. Danh sách leader được xác định từ role và voice channel hiện tại trên Discord, không lưu vào database.

`npm run dev` chạy TypeScript. `npm run migrate` chỉ cập nhật schema; bước nhập Group A chạy khi ứng dụng khởi động. `npm run commands:register` đăng ký command riêng bằng Bot 1 sau khi build.

## Thiết lập Discord

1. Tạo ba bot application riêng cho Group A; thêm ba application cho Group B. Mời tất cả vào cùng server bằng scope `bot`. Bot 1 cần thêm `applications.commands`.
2. Cho từng bot quyền **View Channel**, **Connect**, **Speak** tại channel được phân công. Chừa một chỗ cho bot nếu channel giới hạn người. Không cần Administrator.
3. Tạo/chọn role Leader, sao chép Role ID vào `LEADER_ROLE_ID`; dùng chung role này cho mọi group. Không dùng role @everyone. Sao chép Server ID và ba Voice Channel ID cũ bằng Developer Mode. Chỉ dùng regular voice channels, không dùng Stage.
4. Bật **Server Members Intent** trong Discord Developer Portal → Bot cho **từng bot application**, kể cả bot đang idle. Bot dùng `Guilds`, `GuildVoiceStates` và `GuildMembers` để nhận thay đổi role ngay; không cần Message Content. Không server mute/deafen bot.

Gán role Leader trực tiếp trên Discord cho các thành viên cần relay. Relay bắt đầu khi group active và họ vào voice channel đã cấu hình. Thêm/gỡ role hoặc chuyển channel cập nhật relay ngay; nhiều leader cùng team có thể nói đồng thời. Đổi tên role không ảnh hưởng vì bot dùng Role ID. Người cùng channel nghe leader trực tiếp; bot không phát ngược bất kỳ nguồn nào của team đó về chính team.

## Slash commands

Chỉ Bot 1 đăng ký và xử lý commands. Gateway của Bot 1 vẫn hoạt động khi Group A paused hoặc team cũ số 1 đã được gỡ. Nếu gateway Bot 1 offline, commands tạm thời không khả dụng; các worker khác tiếp tục relay.

| Lệnh | Hành vi |
| --- | --- |
| `/group create name:Bravo` | Tạo group **paused** |
| `/group list` | Tên, số team và trạng thái groups |
| `/group info group:Bravo` | Teams, leaders, kết nối và lỗi của group |
| `/group pause group:Bravo` | Ngừng audio, rời voice; giữ cấu hình và worker đã phân công |
| `/group resume group:Bravo` | Bật group và kết nối lại workers |
| `/group delete group:Bravo` | Xác nhận rồi xóa group cùng teams; không cho xóa Group A |
| `/team add group:Bravo channel:<voice>` | Thêm team và giữ chỗ worker còn trống |
| `/team remove channel:<voice>` | Xác nhận rồi gỡ team, giải phóng worker |
| `/team list group:Bravo` | Teams và trạng thái thuộc group |
| `/leader list group:Bravo` | Tất cả leader đang trong voice của group; bỏ `group` để xem Group A |
| `/leader show channel:<voice>` | Tất cả leader đang trong voice của một team |
| `/status` | Tổng quan PostgreSQL, groups và tất cả workers |
| `/voice move-all` | Bảng riêng tư chọn nhiều nguồn, một đích, xem trước và xác nhận chuyển người |
| `/voice move-status job:<id>` | Xem tiến độ, tổng kết và kết quả từng người của một tác vụ |

`/leader set` và `/leader remove` đã bỏ; nếu Discord còn lưu lệnh cũ, bot chỉ hướng dẫn thêm/gỡ role và không ghi database. `/leader show team:1` vẫn chọn đúng team gốc của Group A. Chọn **một** trong `team` hoặc `channel`. Nếu team gốc đã bị gỡ, số cũ báo không còn tồn tại và không được cấp lại cho team khác. Worker 1–3 được giữ cho các team gốc, kể cả khi team đó đã gỡ.

Group được chọn từ autocomplete theo tên, truyền ID ổn định. Tên group dài 1–80 ký tự, duy nhất trong server, không phân biệt hoa/thường. Một channel chỉ thuộc một team; một worker chỉ phục vụ một channel; leader thuộc team theo voice channel hiện tại, không giới hạn số leader/team. Bot account có role Leader vẫn không được relay.

Tất cả phản hồi ephemeral bằng tiếng Việt; kết quả dài có nút chuyển trang. Thành viên được dùng các lệnh xem relay. Thay đổi cấu hình relay yêu cầu **Manage Server / Manage Guild** (bao gồm Administrator) hoặc role trong `ADMIN_ROLE_IDS`; ứng dụng fetch lại quyền mỗi lần thay đổi. Xóa group/team yêu cầu nút xác nhận trong **60 giây**, chỉ người chạy lệnh được xác nhận. Quyền và cấu hình mục tiêu được kiểm tra lại; nếu cấu hình đã đổi, chạy lại lệnh.

## Di chuyển hàng loạt người trong voice

`/voice move-all` và `/voice move-status` yêu cầu **Move Members** cùng **Manage Guild** hoặc **Administrator**. `ADMIN_ROLE_IDS` không cấp quyền cho hai lệnh này. Cấp Bot 1 **View Channel**, **Connect**, **Move Members** trên mọi nguồn/đích được chọn; Connect tại nguồn còn dùng để xác minh voice state mới nhất qua Discord API. Không cần thêm bot/service, Message Content hay quyền Administrator cho bot.

1. Mở `/voice move-all`, chọn 1–25 voice channel nguồn mỗi lượt rồi bấm **Thêm nguồn**. Lặp lại để tích lũy trên 25 nguồn; channel trùng được loại theo ID. Tổng số nguồn chịu giới hạn thực tế của guild và thời hạn phiên, không có trần nghiệp vụ 3 hoặc 25 nguồn.
2. Chọn đúng một đích khác mọi nguồn. **Danh sách đã chọn** phân trang và cho xóa nguồn trên từng trang, kể cả channel đã bị xóa trên Discord. Có thể dùng menu nguồn với nút **Xóa nguồn**, hoặc **Xóa tất cả**.
3. Bấm **Xem trước** để chụp snapshot người thật, số lượng mỗi nguồn và bot bị bỏ qua. Đích phải đủ chỗ cho toàn bộ snapshot, tính cả những người/bot đã ở đích. Không xác nhận khi nguồn toàn bot/trống, channel không hợp lệ hoặc thiếu quyền.
4. **Xác nhận** trong 60 giây. Phiên chọn có hạn tuyệt đối 10 phút từ khi mở; preview không kéo dài thời hạn này. Quay lại/sửa lựa chọn yêu cầu snapshot mới. Hủy/hết hạn trước khi chạy không chuyển ai. Khi đã bắt đầu không có nút hủy hay undo.

Mỗi guild chỉ có một job chạy. Chỉ người thuộc snapshot và vẫn trong một nguồn đã chọn ở lượt xử lý mới được chuyển; người mới vào không được thêm, người đã rời nguồn/ở đích được bỏ qua. Mọi bot account luôn bị bỏ qua. Leader và member được xử lý như nhau, không phụ thuộc Relay Group; leader rời channel team sẽ ngừng được thu theo logic relay hiện có. Không sửa mapping team/group/leader hoặc kết nối bot.

Job xử lý tuần tự và cập nhật tiến độ tối đa mỗi 5 giây, sau đó tổng kết `Completed`, `Partially Completed`, `Failed` hoặc `Interrupted`. Từng người có kết quả `moved`, `skipped`, `failed`, hoặc `unknown` khi không xác định được Discord đã nhận thao tác hay chưa. Kết quả `unknown` được tính trong thất bại/chưa rõ, không tuyên bố đã chuyển thành công. Không rollback hay tự gửi lại yêu cầu có kết quả chưa rõ. Channel đầy trong lúc chạy được ghi nhận là thất bại; bot không cố vượt giới hạn dù có quyền quản trị.

Migration `003` thêm `voice_move_jobs` và `voice_move_members`, lưu snapshot, người gọi/guild, nguồn/đích, thời gian và kết quả từng người. Phiên hủy/hết hạn được audit là `Cancelled`. Bản ghi kết thúc được giữ **90 ngày**, dọn khi khởi động và hằng ngày; job đang chạy không bị dọn. Không lưu interaction token, nội dung hội thoại hoặc audio. Xem lại bằng `/voice move-status job:<id>` với cùng quyền quản trị, kể cả sau restart hoặc khi webhook ephemeral hết hạn.

Sau restart, job dang dở được đánh dấu `Interrupted` sau khi lấy instance lease; giữ kết quả đã lưu, đánh dấu lượt đang xử lý là `unknown` và các lượt chưa chạy là thất bại do gián đoạn. Không tự chạy lại. Quản trị viên đối chiếu trạng thái Discord/kết quả từng người trước khi mở tác vụ mới. Mất database trong lúc ghi kết quả dừng các lượt tiếp theo; nếu chưa thể ghi trạng thái kết thúc, job vẫn khóa guild cho tới khi phục hồi lúc restart.

API không có thao tác nguyên tử “chỉ chuyển nếu user vẫn ở nguồn”: vẫn có khoảng đua giữa lần kiểm tra cuối và PATCH. Hàng đợi kiểm tra lại voice state trước mỗi lần gửi và sau thời gian chờ rate limit. Transport PATCH tắt retry cho timeout/5xx và trả 429 về worker để chờ theo Discord rồi kiểm tra lại, thay vì gửi lại mù quáng. Nguồn tham chiếu: [Modify Guild Member](https://docs.discord.com/developers/resources/guild#modify-guild-member), [Get User Voice State](https://docs.discord.com/developers/resources/voice#get-user-voice-state), [Rate Limits](https://docs.discord.com/developers/topics/rate-limits).

## Cấu hình và dữ liệu

| Biến | Yêu cầu / mặc định |
| --- | --- |
| `BOT_TOKEN_1`, `BOT_TOKEN_2`, `BOT_TOKEN_3` | Ba token gốc, bắt buộc và khác nhau |
| `BOT_TOKEN_4`, `BOT_TOKEN_5`, `BOT_TOKEN_6` | Thêm để có ba worker cho Group B; không bắt buộc nếu chỉ chạy A |
| `BOT_TOKEN_n` với n > 6 | Tùy chọn để mở rộng pool workers |
| `GUILD_ID` | Server Discord duy nhất |
| `LEADER_ROLE_ID` | Bắt buộc; ID role Leader trong server, dùng chung mọi group; không dùng @everyone |
| `VOICE_CHANNEL_ID_1..3` | Ba channel gốc, bắt buộc; chỉ nhập vào Group A khi khởi tạo lần đầu |
| `DATABASE_URL` | PostgreSQL URL, dùng kết nối trực tiếp với session ổn định |
| `ADMIN_ROLE_IDS` | Danh sách role ID phân cách bằng dấu phẩy, tùy chọn |
| `JITTER_BUFFER_MS` | `60`; bội số 20, từ 0 đến 500, nhỏ hơn `MAX_QUEUE_MS` |
| `MAX_QUEUE_MS` | `200`; bội số 20, từ 20 đến 1000 |
| `SINGLE_SOURCE_GAIN` | `1`; từ 0 đến 2 |
| `MIX_SOURCE_GAIN` | `0.5` cho mỗi nguồn khi trộn nhiều nguồn; từ 0 đến 1 |
| `LOG_LEVEL` | `info`; fatal/error/warn/info/debug/trace/silent |

Không cần `VOICE_CHANNEL_ID_4..6`: thêm channel mới bằng `/team add`. Dùng Role ID trong `LEADER_ROLE_ID`, không dùng User ID hoặc tên role. Token chỉ nằm trong môi trường bí mật, không vào database, phản hồi hoặc log.

Database lưu ID group/team, trạng thái active/paused, channel, phân công leader cũ chỉ để rollback, khóa worker và Discord Bot User ID đã xác minh. Khóa worker là số `n` trong `BOT_TOKEN_n`; **không đổi số khóa giữa các account**. Có thể rotate token của cùng account. Đổi sang một account khác tại khóa đã lưu sẽ báo `BOT_IDENTITY_CONFLICT`, không cho account đó relay.

Team paused vẫn giữ chỗ worker. Khi thiếu token đã phân công, ứng dụng hiển thị lỗi riêng của team và không lấy worker khác thay thế. Thêm team khi hết worker bị từ chối; resume group bị từ chối nếu thiếu token. Workers 1–3 không được cấp cho team mới.

Migration `002` thêm các bảng `relay_*`, giữ nguyên `leader_assignments` và `leader_audit`. Bản dùng role không cần migration mới và không ghi phân công leader khi role thay đổi. Các bảng/cột leader cũ vẫn được giữ để hỗ trợ rollback; code tương thích repository cũ được giữ nhưng không còn được commands gọi để gán leader. Audit lưu thay đổi cấu hình và người thao tác; không ghi âm thanh. Trước COMMIT, lỗi mutation giữ nguyên cấu hình đang chạy. Nếu không xác định được kết quả COMMIT cấu hình hoặc mất instance lease, ứng dụng dừng relay và thoát để tải lại trạng thái bền vững.

## Audio và khôi phục kết nối

- Mỗi group có một `AudioRouter`, timer và danh sách nguồn riêng. Mỗi người nói có receive stream, codec, queue và epoch riêng. Chỉ subscribe leader không phải bot ở đúng channel; giọng member và mọi relay bot bị bỏ qua.
- Giữ engine Opus → PCM stereo signed 16-bit little-endian 48 kHz, frame 20 ms, jitter ngắn, queue có giới hạn và bỏ backlog sau event loop stall. Không ghi âm.
- Mỗi đích trộn tất cả nguồn thuộc các team khác trong cùng group, không ưu tiên người nói trước. Một nguồn dùng gain 1; nhiều nguồn dùng gain 0,5 mỗi nguồn theo cấu hình, giới hạn sample chống clipping. Số nguồn có thể lớn hơn số team; không ưu tiên một leader duy nhất trong team.
- Gỡ role hoặc leader rời/chuyển channel vô hiệu hóa epoch/callback của nguồn đó và reset output trong đúng group để bỏ audio đang chờ. Audio đã gửi tới Discord hoặc thiết bị vẫn có độ trễ ngắn.
- Pause đóng capture, queue, output và voice connection của group; resume không phát audio cũ. Reconnect từng worker độc lập, exponential backoff kèm jitter tối đa 30 giây. Bot bị move/kick sẽ về channel được lưu. Sau gateway reconnect, bot fetch lại role và member đang ở channel trước khi thu âm; nếu chưa xác minh được thì chưa relay.
- `/status` báo `MISSING_VOICE_PERMISSIONS`, `INVALID_VOICE_CHANNEL`, `INVALID_LEADER_ROLE`, `BOT_IDENTITY_CONFLICT` hoặc mã lỗi an toàn. `/leader list`, `/leader show`, `/group info` và `/status` hiển thị leader từ runtime; trạng thái chưa xác minh/offline được phân biệt với channel chưa có leader. Group bị lỗi mixer ngừng riêng; dùng pause/resume để thử lại. Các group dùng chung process vẫn cùng chịu lỗi process, database lease hoặc thiếu tài nguyên toàn máy.
- Ưu tiên native `@discordjs/opus`; fallback `opusscript` khi thiếu native binary. Không cần FFmpeg. Nhận audio từ Discord cần nghiệm thu trên server thật khi nâng phiên bản thư viện hoặc trước phiên vận hành quan trọng.

## Railway và nâng cấp từ bản ba team

Giữ một service bot cùng PostgreSQL bền vững. `railway.toml` đã đặt một replica, tắt sleep, `overlapSeconds=0` và thời gian drain 15 giây. Không bật nhiều region/replica hoặc HTTP healthcheck cho worker này. Instance lease PostgreSQL ngăn hai process điều khiển cùng bộ bot. Không dùng PgBouncer transaction pooling cho `DATABASE_URL`.

1. **Sao lưu PostgreSQL trước nâng cấp**, lưu cấu hình channel/token gốc và commit/image của phiên bản đang chạy. Dùng `pg_dump` với định dạng custom; thử khả năng khôi phục trên database riêng.
2. Thêm `LEADER_ROLE_ID`, gán role cho các thành viên cần relay và bật Server Members Intent cho tất cả bot applications trước khi redeploy bản mới. Có một khoảng gián đoạn khi restart. Kiểm tra Group A có đúng ba channel, các leader theo role và worker 1–3; nghiệm thu relay của A trước khi bật B.
3. Mời ba bot mới vào Discord và thêm `BOT_TOKEN_4..6` bằng Railway Variables, giữ nguyên token 1–3. Redeploy để tải worker mới; kiểm tra lại Group A.
4. Chạy `/group create name:Bravo`, thêm ba channel qua `/team add group:Bravo channel:...`. Group vẫn paused, các worker 4–6 đã được giữ chỗ.
5. Gán role Leader trên Discord cho các thành viên, kiểm tra `/group info`, rồi `/group resume group:Bravo`.
6. Chạy các kịch bản nghiệm thu bên dưới. Theo dõi CPU/RAM/network khi nhiều leaders nói đồng thời, bao gồm nhiều người trong một team và trong phiên 30 người đủ dài.

Dừng bằng SIGTERM/SIGINT đóng capture, players, Discord connections và PostgreSQL. Docker dùng Node.js 24, build native Opus bằng toolchain và chạy bằng user `node` ở runtime. Dữ liệu nằm trong PostgreSQL; service bot không cần volume riêng.

## Rollback

- Nếu B gặp lỗi: `/group pause group:Bravo`; xác nhận A tiếp tục relay. Cách này giữ nguyên bản mới và cấu hình B để sửa sau.
- Nếu cần quay về mã cũ: pause B, dừng instance mới hoàn toàn, redeploy commit/image cũ với token/channel 1–3 ban đầu và cùng database. Bản cũ dùng lại phân công leader thủ công đã lưu trước khi chuyển sang role; thay đổi role không được chuyển ngược thành phân công thủ công. Đối chiếu/gán lại leader trong bản cũ nếu cần. Không chạy hai bản đồng thời.
- Để quay về toàn bộ dữ liệu trước nâng cấp, dừng bot và phục hồi bản sao lưu vào database riêng rồi đổi `DATABASE_URL`. Việc khôi phục sẽ bỏ các thay đổi sau thời điểm sao lưu.
- Nếu đã chạy mã cũ và sửa leader sau rollback, khi nâng cấp lại hãy gán role tương ứng trên Discord. Bản dùng role không sử dụng phân công thủ công để quyết định relay và không tự tạo lại team đã gỡ.

## Kiểm thử và nghiệm thu

```sh
npm run check
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/crosstalk_test npm run test:integration
```

`npm run check` gồm typecheck, unit/mocked lifecycle, codec thật và build. Có `TEST_DATABASE_URL` thì toàn bộ integration tests cũng chạy. Integration tạo/xóa schema ngẫu nhiên, cần quyền tạo schema; dùng database test riêng. CI dùng PostgreSQL 17 và build Docker image.

Tự động kiểm tra migration từ schema cũ, mapping bền vững, cấp worker đồng thời, ràng buộc dữ liệu, rollback transaction, bảng leader tương thích bản cũ, quyền/xác nhận command, role runtime, nhiều capture/team, epoch và audio hai group. Các kiểm tra này không thay thế thử voice thực tế trên Discord:

- A hoạt động như cũ trước khi resume B; từng leader chỉ tới hai team khác cùng group, không vọng về nguồn và không sang group kia.
- Member không có role và bot account không được relay. Nhiều leader cùng team và ở cả hai group nói đồng thời đều nghe đủ nguồn trong đúng group.
- Thêm/gỡ role khi đang nói, leader chuyển channel/group hoặc rời/vào voice, pause/resume B: không phát audio cũ, A tiếp tục hoạt động.
- Thử channel trùng, hết worker, thiếu quyền voice, bot B bị kick/move/mất kết nối: báo lỗi riêng và khôi phục đúng mapping.
- Restart/redeploy giữ groups, trạng thái paused và bot assignments; leader được xác định lại theo role và voice channel. Thử rollback trên database sao chép trước khi dùng production.

Mass Voice Move có unit/mocked tests cho nhiều lượt trên 25 nguồn, xóa/quay lại, snapshot, bot exclusion, quyền, hết hạn, bấm lặp, rate limit, lỗi từng người, mất gateway/audit và truy vấn kết quả. Integration PostgreSQL kiểm tra migration, job cạnh tranh, transaction, phục hồi và retention. Trước production, chạy đầy đủ **AC-01–AC-22** trong [đặc tả Mass Voice Move](specs/CALLER_MASS_VOICE_MOVE_SPEC.md) trên Discord test server, gồm hai relay group hoạt động, bot giữ nguyên vị trí, leader ngừng/tiếp tục relay đúng channel, đích đầy và restart giữa job. Chỉ đánh dấu đã nghiệm thu sau khi thực sự thực hiện trên Discord.

Chưa bao gồm dashboard, nhiều server, ghi âm, tự chia team hoặc điều phối nhiều service. Không có Discord token production được cấu hình sẵn trong repository; chỉ xác nhận nghiệm thu voice/Railway sau khi thực sự chạy các bước này.
