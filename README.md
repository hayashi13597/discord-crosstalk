# Discord CrossTalk Bot

Ứng dụng Node.js + TypeScript dùng nhiều Discord bot account để chuyển giọng của leader giữa các voice team trong cùng group. Leader là thành viên có role `LEADER_ROLE_ID` đang trong channel của team; member nói nội bộ. Không chuyển audio sang group khác hoặc phát ngược về channel nguồn.

Bot dùng **SQLite local**, không cần PostgreSQL service. Với DB mới hoặc sau khi `/stop`, khởi động ứng dụng chỉ đăng nhập gateway để nhận lệnh và **chờ `/start` trước khi vào voice**; nếu phiên đang `/start` khi tiến trình restart/redeploy hoặc crash, bot tự khôi phục phiên cho các group `active` (giữ nguyên group `paused`).

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
| `/start` | Bật và lưu phiên cho tất cả group active, giữ nguyên group paused; xem `/status` để biết kết nối thực tế |
| `/stop` | Ngắt toàn bộ voice/audio và reconnect, lưu trạng thái dừng, giữ gateway online |
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
| `/voice set-destination channel:<voice>` | Lưu voice đích mặc định cho server |
| `/voice set-sources channel:<voice> [channel-2:<voice> …]` | Lưu 1–25 voice nguồn, thay thế danh sách cũ |
| `/voice move-config` | Xem cấu hình nguồn/đích đã lưu |
| `/voice move-all` | Chuyển ngay theo cấu hình nguồn/đích đã lưu |
| `/voice move-status job:<id>` | Xem tiến độ và lịch sử tác vụ |

Đổi channel bằng `/team remove` rồi `/team add`. Xác nhận xóa hết hạn sau 60 giây, chỉ người chạy lệnh dùng được. Cấu hình channel/team, trạng thái active/paused, worker assignments và trạng thái phiên (`/start` / `/stop`) đều được lưu trong SQLite qua restart. Trong phiên đã start, bot tự reconnect khi mất kết nối tạm thời hoặc khi container restart. Gọi start/stop lặp lại không tạo kết nối trùng.

## Di chuyển hàng loạt người trong voice

Các lệnh `/voice` yêu cầu **Move Members** cùng **Manage Guild** hoặc **Administrator**. `ADMIN_ROLE_IDS` không cấp quyền cho các lệnh này. Cấp Bot 1 **View Channel**, **Connect**, **Move Members** trên mọi nguồn/đích được chọn; Connect tại nguồn còn dùng để xác minh voice state mới nhất qua Discord API. Không cần thêm bot/service, Message Content hay quyền Administrator cho bot.

1. Dùng `/voice set-sources channel:<voice> channel-2:<voice>` để lưu 1–25 voice nguồn. Mỗi tham số mở danh sách chọn voice channel giống `set-destination`; `channel` bắt buộc, `channel-2` đến `channel-25` tùy chọn. Mỗi lần cài sẽ thay thế danh sách nguồn cũ; channel trùng được gộp.
2. Dùng `/voice set-destination channel:<voice>` để lưu voice đích. Cả nguồn và đích được lưu qua restart, có thể cài theo bất kỳ thứ tự nào. Xem bằng `/voice move-config`.
3. Chạy `/voice move-all` để chuyển ngay theo cấu hình đã lưu, không có bảng chọn hay bước xác nhận. Bot chụp snapshot mới và kiểm tra quyền trước khi chuyển. Đích phải khác mọi nguồn và đủ chỗ; chưa đủ cấu hình, channel đã xóa/không hợp lệ hoặc thiếu quyền đều báo lỗi và không chuyển ai. Cài lại nguồn/đích nếu kênh đã thay đổi.

Không có nút hủy hay undo khi job đã chạy. Thay đổi cấu hình áp dụng cho lần gọi tiếp theo, không thay đổi nguồn/đích của job đang chạy.

Mỗi guild chỉ có một job chạy. Bot chụp danh sách ban đầu rồi quét lại các nguồn sau mỗi vòng để bổ sung người mới vào và người quay lại nguồn. Chỉ chuyển người còn trong một nguồn đã cấu hình khi kiểm tra; người đã rời nguồn/ở đích được bỏ qua. Mọi bot account luôn bị bỏ qua. Leader và member được xử lý như nhau, không phụ thuộc Relay Group; leader rời channel team sẽ ngừng được thu theo logic relay hiện có. Không sửa mapping team/group/leader hoặc kết nối bot.

Job xử lý tuần tự, tối đa **5 vòng**, **3 lần thử mỗi người**, trong **2 phút** kể từ khi job được lưu (yêu cầu đang gửi có thể cần thêm thời gian để kết thúc). Lỗi tạm thời được thử lại với thời gian chờ; rate limit tuân theo thời gian Discord trả về. Trước mỗi lần gửi lại, bot đọc vị trí voice hiện tại: đã ở đích hoặc đã rời nguồn thì không gửi PATCH. Timeout/5xx sau khi gửi được ghi `unknown`; bot không thử lại PATCH nếu chưa đọc được vị trí mới. Lỗi riêng của một người không ngăn xử lý những người còn lại. Mất quyền, kênh không khả dụng, đích đầy, mất gateway, lỗi audit hoặc lỗi gửi tiến độ bất thường vẫn dừng job (riêng trường hợp người gọi tự đóng tin nhắn tiến độ ephemeral hoặc hết hạn interaction token thì job vẫn tiếp tục hoàn tất và xem lại qua `/voice move-status`).

Chỉ báo **đã chuyển hết người thật khỏi nguồn** sau hai lần quét không còn người/chưa xác minh, cách nhau một giây. Đây là trạng thái tại lần kiểm tra cuối; người vẫn có thể vào lại sau đó. Nguồn ban đầu trống vẫn được kiểm tra và có thể hoàn tất mà không chuyển ai. Nếu còn người, hết giới hạn hoặc không xác minh được, kết quả ghi rõ tình trạng và Job ID; `/voice move-status` có danh sách còn ở nguồn, chưa xác minh và kết quả từng người. Thời điểm kiểm tra được lưu trong SQLite; nếu job dừng trước khi kiểm tra được, bot không tuyên bố nguồn đã trống. Không rollback. Kết quả `unknown` được tính trong thất bại/chưa rõ, không tuyên bố đã chuyển thành công. Bot không cố vượt giới hạn channel dù có quyền quản trị.

Schema SQLite tạo `voice_move_jobs` và `voice_move_members`, lưu snapshot, người gọi/guild, nguồn/đích, thời gian và kết quả từng người. Lịch sử `Cancelled` từ phiên bản dùng bảng chọn vẫn xem được. Bản ghi kết thúc (cùng lịch sử `relay_audit`) được giữ **90 ngày**, dọn khi khởi động và hằng ngày; job đang chạy không bị dọn. Không lưu interaction token, nội dung hội thoại hoặc audio. Xem lại bằng `/voice move-status job:<id>` với cùng quyền quản trị, kể cả sau restart hoặc khi webhook ephemeral hết hạn.

Sau restart, job dang dở được đánh dấu `Interrupted` sau khi lấy instance lease; giữ kết quả đã lưu, đánh dấu lượt đang xử lý là `unknown` và các lượt chưa chạy là thất bại do gián đoạn. Không tự chạy lại. Quản trị viên đối chiếu trạng thái Discord/kết quả từng người trước khi mở tác vụ mới. Mất database trong lúc ghi kết quả dừng các lượt tiếp theo; nếu chưa thể ghi trạng thái kết thúc, job vẫn khóa guild cho tới khi phục hồi lúc restart.

API không có thao tác nguyên tử “chỉ chuyển nếu user vẫn ở nguồn”: vẫn có khoảng đua giữa lần kiểm tra cuối và PATCH. Hàng đợi kiểm tra lại voice state trước mỗi lần gửi. Transport PATCH tắt retry ngầm cho timeout/5xx; worker chờ rate limit và chỉ gửi lại theo giới hạn sau khi đọc voice state mới. Nguồn tham chiếu: [Modify Guild Member](https://docs.discord.com/developers/resources/guild#modify-guild-member), [Get User Voice State](https://docs.discord.com/developers/resources/voice#get-user-voice-state), [Rate Limits](https://docs.discord.com/developers/topics/rate-limits).

## Database và vận hành

`DATABASE_PATH` mặc định `./data/crosstalk.sqlite`, được resolve theo working directory. Bot tự tạo thư mục/schema (quyền `0700` trên hệ thống POSIX), bật foreign keys và WAL (`synchronous = NORMAL`). Không cấu hình `:memory:` cho bot. Các biến audio (`JITTER_BUFFER_MS=60`, `MAX_QUEUE_MS=200`, `SINGLE_SOURCE_GAIN=1`, `MIX_SOURCE_GAIN=0.5`) và `LOG_LEVEL=info` giữ mặc định như `.env.example`.

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
7. Trên Discord: `/team add` cho các channel nếu DB mới → `/start` → `/status`. Phiên đã `/start` được lưu trong volume SQLite và tự khôi phục sau restart/redeploy (dùng `/stop` khi muốn ngắt hẳn phiên).

Tham khảo: [Railpack Node.js](https://railpack.com/languages/node/), [Railway Volumes](https://docs.railway.com/volumes), [Railway deployment lifecycle](https://docs.railway.com/deployments/reference).

### Khi bot bị timeout lúc khởi động

`DISCORD_GATEWAY_TIMEOUT` nghĩa là worker chưa hoàn tất kết nối gateway trong 30 giây, trước bước vào voice. Log ghi rõ `login`, `client_ready` hoặc `resume` và trạng thái gateway. Đây chưa đủ để kết luận lỗi token hay mạng. Đặt `LOG_LEVEL=debug` trong Railway Variables rồi redeploy để xem bước cuối cùng trước timeout (lấy gateway URL, mở WebSocket, identify hoặc chờ guild). Mỗi worker có số `worker` trong log; sau khi chẩn đoán có thể trả về `LOG_LEVEL=info`.

Nếu debug dừng ở `Preparing to connect to the gateway...` mà chưa có `Fetched Gateway Information`, worker đang chờ HTTPS `GET /gateway/bot`. Log `Discord gateway HTTP response` ghi HTTP status, content type và một số header chẩn đoán; `Discord gateway HTTP request failed` ghi lỗi mạng cùng `networkCode` từ nguyên nhân gốc, ví dụ `EAI_AGAIN`, `ENETUNREACH`, `UND_ERR_CONNECT_TIMEOUT`. Không log authorization, response body hoặc phần token được thư viện che một phần. Các log HTTP này có ở mức `info`/`warn`, không cần bật debug.

HTTP của worker timeout sau 15 giây và không retry ngầm; supervisor chịu trách nhiệm thử lại với backoff. Điều này tránh request cũ còn chạy khi deadline gateway 30 giây đã tạo client mới. Khi `GET /gateway/bot` trả `429`, worker lưu cooldown qua các lần thay client/thay cấu hình và đợi ít nhất `Retry-After` trước khi đăng nhập lại (tối thiểu 30 giây nếu thiếu hoặc thời gian ngắn hơn). Các route khác vẫn dùng hàng đợi rate limit của discord.js. Xem [Discord rate limits](https://docs.discord.com/developers/topics/rate-limits).

- `DISCORD_GATEWAY_CLOSED_4014` / `Used disallowed intents`: bật **Server Members Intent** tại Developer Portal → application tương ứng → Bot → Privileged Gateway Intents cho **từng bot**, rồi redeploy. Code cần intent này để cập nhật role leader. Xem [Discord Gateway intents](https://docs.discord.com/developers/events/gateway#privileged-intents).
- `DISCORD_GATEWAY_CLOSED_4004` / `Authentication failed` / `TokenInvalid`: kiểm tra `BOT_TOKEN_n` của worker tương ứng trong Railway Variables.
- `DISCORD_GATEWAY_RATE_LIMITED` / `Discord gateway rate limited; delaying next login`: xem `retryAfterMs` và HTTP response ngay trước đó. Nếu `403`/`429` đi kèm HTML từ Cloudflare, cần kiểm tra khả năng IP đi ra của container bị chặn; không kết luận token/intent bị sai chỉ từ timeout. Không restart liên tục vì sẽ tạo thêm yêu cầu đăng nhập; cooldown trong bộ nhớ không tồn tại qua restart tiến trình.
- `Discord REST rate limited`: các route khác đang chờ hàng đợi rate limit của thư viện.
- Timeout khi lấy gateway URL hoặc mở WebSocket: kiểm tra kết nối HTTPS/WSS đi ra Discord từ container Railway. Chỉ khi có log xác nhận mới kết luận đây là lỗi mạng; nếu nhiều worker cùng lỗi, kiểm tra kết nối chung trước.

`.env not found. Continuing without it.` bình thường khi cấu hình qua Railway Variables; cảnh báo npm về `production` cũng không chặn khởi động. `FFmpeg: not found` và các thư viện mã hóa tùy chọn chưa cài trong dependency report không giải thích gateway timeout. Luồng relay hiện tại encode/decode Opus trực tiếp, không dùng FFmpeg.

## Kiểm thử

```sh
npm run check
npm run test:integration
```

Integration tests SQLite dùng file tạm, không cần database service. Chúng kiểm tra migration, lưu channel/worker, rollback, phục hồi voice-move, retention và khóa instance.

Cần nghiệm thu thủ công trên Discord test server: cấu hình channel → start → pause/resume → restart (tự khôi phục group active, group paused vẫn nghỉ) → stop → restart (đảm bảo sau `/stop` thì restart không tự vào voice), và chỉ leader được relay đúng group. Kiểm tra thiếu quyền channel, hết worker, mất kết nối và Mass Voice Move. Automated tests không thay thế kiểm tra audio thực tế.
