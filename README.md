# Discord CrossTalk Bot

Ứng dụng Node.js + TypeScript dùng nhiều Discord bot account để chuyển giọng của leader giữa các voice team trong cùng group. Leader là thành viên có role `LEADER_ROLE_ID` đang trong channel của team; member nói nội bộ. Không chuyển audio sang group khác hoặc phát ngược về channel nguồn.

Bot dùng **SQLite local**, không cần PostgreSQL service. Khởi động ứng dụng chỉ đăng nhập gateway để nhận lệnh; **luôn chờ `/start` trước khi vào voice**, kể cả sau restart.

## Chạy local

Yêu cầu Node.js 22.16+ thuộc nhánh 22, hoặc Node.js >=24 (khuyến nghị Node 24), npm và ít nhất ba bot application riêng biệt.

```sh
npm ci
cp .env.example .env
```

Điền `BOT_TOKEN_1`, `BOT_TOKEN_2`, `BOT_TOKEN_3`, `GUILD_ID`, `LEADER_ROLE_ID`. Có thể thêm `BOT_TOKEN_4` trở lên. Cấu hình channel bằng `/team add`.

```sh
npm run build
npm run commands:register
npm start
```

`npm run dev` chạy TypeScript. `npm run migrate` chỉ cập nhật schema SQLite (dừng bot trước khi chạy). Bot tự migrate khi khởi động. Lệnh đăng ký command dùng Bot 1; phải chạy lại để Discord có `/start` và `/stop`.

DB mới tạo **Group A active, chưa có team**. Dùng Discord commands:

1. `/team add group:Group A channel:<voice-1>`
2. Thêm các channel khác bằng `/team add`.
3. `/start` để các bot vào voice của group active.
4. `/status` để kiểm tra kết nối; `/stop` cho tất cả bot rời voice.

Chọn group từ autocomplete. Worker trống được cấp theo ID tăng dần, bao gồm workers 1–3. Mỗi channel chỉ thuộc một team; mỗi worker chỉ phục vụ một channel. Hết worker thì cần thêm `BOT_TOKEN_n` và restart. Không đổi số worker giữa các bot account; có thể rotate token của cùng account.

## Thiết lập Discord

- Mời từng bot vào cùng server bằng scope `bot`; Bot 1 cần thêm `applications.commands`.
- Cho bot **View Channel**, **Connect**, **Speak** tại channel được phân công, chừa chỗ nếu channel giới hạn người. Dùng regular voice channel, không dùng Stage.
- Bật **Server Members Intent** cho từng application, kể cả bot idle. Không cần Message Content hoặc Administrator; không server mute/deafen bot.
- Tạo role Leader, đặt Role ID vào `LEADER_ROLE_ID` và gán role cho người cần relay. Không dùng @everyone. Leader được xác định lại từ role và voice channel, hỗ trợ nhiều leader/team.

## Slash commands

Chỉ Bot 1 nhận và xử lý commands; gateway vẫn online khi chưa start hoặc đã stop. Lệnh xem dùng được cho thành viên. `/start`, `/stop` và thay đổi cấu hình cần **Manage Server** hoặc role trong `ADMIN_ROLE_IDS`; quyền được fetch lại mỗi lần. Phản hồi ephemeral bằng tiếng Việt.

| Lệnh | Hành vi |
| --- | --- |
| `/help` | Xem tất cả lệnh, tham số và quyền sử dụng |
| `/start` | Bật phiên cho tất cả group active, giữ nguyên group paused; xem `/status` để biết kết nối thực tế |
| `/stop` | Ngắt toàn bộ voice/audio và reconnect, giữ gateway online |
| `/status` | Sức khỏe SQLite, trạng thái phiên, groups và workers |
| `/group create name:Bravo` | Tạo group paused |
| `/group list` | Liệt kê groups |
| `/group info group:Bravo` | Xem cấu hình và kết nối |
| `/group pause group:Bravo` | Ngắt voice group, giữ channel và worker |
| `/group resume group:Bravo` | Bật group; chỉ kết nối khi phiên đã `/start` |
| `/group delete group:Bravo` | Xác nhận xóa group và teams; Group A được giữ lại |
| `/team add group:Bravo channel:<voice>` | Lưu channel và cấp worker trống |
| `/team remove channel:<voice>` | Xác nhận gỡ channel, giải phóng worker |
| `/team list group:Bravo` | Xem teams |
| `/leader list group:Bravo` | Xem leader theo role; bỏ group để xem Group A |
| `/leader show channel:<voice>` | Xem leader của channel |
| `/voice move-all` | Chuyển hàng loạt người qua bảng chọn |
| `/voice move-status job:<id>` | Xem tiến độ và lịch sử tác vụ |

Đổi channel bằng `/team remove` rồi `/team add`. Xác nhận xóa hết hạn sau 60 giây, chỉ người chạy lệnh dùng được. Cấu hình channel/team, trạng thái active/paused và worker assignments tồn tại sau restart. Trạng thái phiên start không được lưu. Trong phiên đã start, bot tự reconnect khi mất kết nối tạm thời. Gọi start/stop lặp lại không tạo kết nối trùng.

## Di chuyển hàng loạt người trong voice

`/voice move-all` và `/voice move-status` yêu cầu **Move Members** cùng **Manage Guild** hoặc **Administrator**. `ADMIN_ROLE_IDS` không cấp quyền cho hai lệnh này. Cấp Bot 1 **View Channel**, **Connect**, **Move Members** trên mọi nguồn/đích được chọn; Connect tại nguồn còn dùng để xác minh voice state mới nhất qua Discord API. Không cần thêm bot/service, Message Content hay quyền Administrator cho bot.

1. Mở `/voice move-all`, chọn **Voice nguồn** (1–25 channel) và **Voice đích** (một channel). Sửa menu nguồn sẽ thay thế trực tiếp lựa chọn hiện tại; không tích lũy qua nhiều lượt.
2. Bấm **Xác nhận** để kiểm tra quyền, chụp snapshot người thật rồi chạy ngay. Không có bước xem trước. Đích phải khác mọi nguồn và đủ chỗ cho toàn bộ snapshot; nguồn toàn bot/trống, channel không hợp lệ hoặc thiếu quyền đều báo lỗi rồi đóng phiên.
3. Bấm **Hủy** để kết thúc mà không chuyển ai. Phiên chọn hết hạn sau 10 phút kể từ khi mở. Khi đã xác nhận không có nút hủy hay undo; gặp lỗi phải mở lại lệnh để chạy tác vụ mới.

Mỗi guild chỉ có một job chạy. Chỉ người thuộc snapshot và vẫn trong một nguồn đã chọn ở lượt xử lý mới được chuyển; người mới vào không được thêm, người đã rời nguồn/ở đích được bỏ qua. Mọi bot account luôn bị bỏ qua. Leader và member được xử lý như nhau, không phụ thuộc Relay Group; leader rời channel team sẽ ngừng được thu theo logic relay hiện có. Không sửa mapping team/group/leader hoặc kết nối bot.

Job xử lý tuần tự, hiển thị “Đang chuyển…” và kết thúc bằng tổng số đã chuyển/bỏ qua. Gặp lỗi đầu tiên (kể cả rate limit, lỗi cập nhật tiến độ hoặc audit), job dừng trước người tiếp theo và được ghi `Interrupted` khi database cho phép. Bảng lỗi chỉ hiện nguyên nhân ngắn gọn, số đã chuyển và Job ID; chi tiết và phân trang nằm trong `/voice move-status`. Các trạng thái lịch sử `Partially Completed` và `Failed` vẫn tra cứu được. Từng người có kết quả `moved`, `skipped`, `failed`, hoặc `unknown` khi không xác định được Discord đã nhận thao tác hay chưa. Kết quả `unknown` được tính trong thất bại/chưa rõ, không tuyên bố đã chuyển thành công. Không rollback hay tự gửi lại yêu cầu có kết quả chưa rõ. Channel đầy trong lúc chạy được ghi nhận là thất bại và dừng tác vụ; bot không cố vượt giới hạn dù có quyền quản trị.

Schema SQLite tạo `voice_move_jobs` và `voice_move_members`, lưu snapshot, người gọi/guild, nguồn/đích, thời gian và kết quả từng người. Phiên hủy/hết hạn được audit là `Cancelled`. Bản ghi kết thúc được giữ **90 ngày**, dọn khi khởi động và hằng ngày; job đang chạy không bị dọn. Không lưu interaction token, nội dung hội thoại hoặc audio. Xem lại bằng `/voice move-status job:<id>` với cùng quyền quản trị, kể cả sau restart hoặc khi webhook ephemeral hết hạn.

Sau restart, job dang dở được đánh dấu `Interrupted` sau khi lấy instance lease; giữ kết quả đã lưu, đánh dấu lượt đang xử lý là `unknown` và các lượt chưa chạy là thất bại do gián đoạn. Không tự chạy lại. Quản trị viên đối chiếu trạng thái Discord/kết quả từng người trước khi mở tác vụ mới. Mất database trong lúc ghi kết quả dừng các lượt tiếp theo; nếu chưa thể ghi trạng thái kết thúc, job vẫn khóa guild cho tới khi phục hồi lúc restart.

API không có thao tác nguyên tử “chỉ chuyển nếu user vẫn ở nguồn”: vẫn có khoảng đua giữa lần kiểm tra cuối và PATCH. Hàng đợi kiểm tra lại voice state trước mỗi lần gửi. Transport PATCH tắt retry cho timeout/5xx; HTTP 429 được ghi là `rate_limited` và dừng tác vụ, không chờ hoặc tự gửi lại. Nguồn tham chiếu: [Modify Guild Member](https://docs.discord.com/developers/resources/guild#modify-guild-member), [Get User Voice State](https://docs.discord.com/developers/resources/voice#get-user-voice-state), [Rate Limits](https://docs.discord.com/developers/topics/rate-limits).

## Database và vận hành

`DATABASE_PATH` mặc định `./data/crosstalk.sqlite`, được resolve theo working directory. Bot tự tạo thư mục/schema, bật foreign keys và WAL. Không cấu hình `:memory:` cho bot. Các biến audio (`JITTER_BUFFER_MS=60`, `MAX_QUEUE_MS=200`, `SINGLE_SOURCE_GAIN=1`, `MIX_SOURCE_GAIN=0.5`) và `LOG_LEVEL=info` giữ mặc định như `.env.example`.

Bot chỉ dùng SQLite và được điều khiển qua Discord commands. Migration tự động bỏ bảng phân công leader cũ, giữ nguyên groups, channel, worker assignments và lịch sử relay/voice-move.

Chỉ chạy một bot process trên cùng file DB. Khóa local được gia hạn mỗi 5 giây; sau crash khóa hết hạn sau khoảng 15 giây. Khi khóa mất hiệu lực, bot dừng relay. Dùng ổ đĩa local, tránh chia sẻ file qua network filesystem.

Chạy trực tiếp bằng Node.js theo hướng dẫn ở trên (`npm run build` rồi `npm start`). Dữ liệu nằm trong file `DATABASE_PATH`; dừng bot trước khi sao lưu hoặc khôi phục file DB. Giữ thư mục dữ liệu khi cập nhật source hoặc cài lại dependencies.

## Deploy lên Railway

1. Push repository lên GitHub, tạo/chọn service tại root repository và dùng builder **Railpack**. Build command: `npm run build`; start command: `npm start`. Nếu service cũ còn chọn Dockerfile thì chuyển sang Railpack và bỏ cấu hình Dockerfile cũ.
2. Đặt `RAILPACK_NODE_VERSION=24` để dùng Node 24. Bot cần `StatementSync.columns()`, có từ Node 22.16; CI kiểm tra cả Node 22.16.0 và 24.
3. Thêm Volume vào service, mount tại `/data`, đặt `DATABASE_PATH=/data/crosstalk.sqlite`. File DB local không tự được upload khi push source. Nếu muốn giữ cấu hình local, dừng bot và sao lưu rồi chuyển file SQLite vào volume trước khi start; nếu không, bot tạo DB mới.
4. Thêm Variables theo `.env.example`: `BOT_TOKEN_1`, `BOT_TOKEN_2`, `BOT_TOKEN_3`, `GUILD_ID`, `LEADER_ROLE_ID`; thêm tokens worker và `ADMIN_ROLE_IDS` nếu cần. Không commit `.env`.
5. Chạy **một replica, một region**, tắt Serverless/sleep. Đặt restart policy On Failure, `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS=0` và `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15`. Bot không có HTTP server: không cấu hình HTTP healthcheck hoặc public domain.
6. Deploy và xem logs. Bot tự migrate DB và đăng ký commands bằng Bot 1 khi gateway sẵn sàng; không chạy migration trong pre-deploy vì volume chỉ có khi runtime start. Dừng bot local nếu dùng cùng bộ tokens trước khi chạy Railway.
7. Trên Discord: `/team add` cho các channel nếu DB mới → `/start` → `/status`. Sau mỗi restart/redeploy phải gọi `/start` lại.

Tham khảo: [Railpack Node.js](https://railpack.com/languages/node/), [Railway Volumes](https://docs.railway.com/volumes), [Railway deployment lifecycle](https://docs.railway.com/deployments/reference).

## Kiểm thử

```sh
npm run check
npm run test:integration
```

Integration tests SQLite dùng file tạm, không cần database service. Chúng kiểm tra migration, lưu channel/worker, rollback, phục hồi voice-move, retention và khóa instance.

Cần nghiệm thu thủ công trên Discord test server: cấu hình channel → start → pause/resume → stop → restart; đảm bảo restart không tự vào voice, group paused không bị start, và chỉ leader được relay đúng group. Kiểm tra thiếu quyền channel, hết worker, mất kết nối và Mass Voice Move. Automated tests không thay thế kiểm tra audio thực tế.
