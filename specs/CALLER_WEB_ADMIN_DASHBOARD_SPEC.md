# Discord CrossTalk Bot — Web Admin Dashboard Specification

**Đối tượng:** Hệ thống Discord CrossTalk Bot đang hoạt động trên Discord và Railway
**Nguyên tắc:** Phát triển dashboard trên source hiện tại; **không viết lại Voice Relay Engine**.

## Quyết định triển khai đã chốt

- Next.js stable latest, dashboard/API là service Railway riêng, worker giữ voice engine; cùng PostgreSQL và authenticated private Control API.
- MVP chỉ phục vụ `GUILD_ID` hiện tại. Không mở rộng nhiều guild trong đợt này.
- **Leaders chỉ xem**, nhiều leader/team theo role Discord hiện tại; không khôi phục `/leader set/remove` hoặc giới hạn một leader/team.
- Mass Move giữ **fail-stop, không retry tự động**; quyền vẫn yêu cầu Manage Guild/Administrator và Move Members cho cả web/slash.
- UI tiếng Việt, dark theme. Bot reconnect thủ công và metrics audio nâng cao để sau MVP.
- Các quyết định này thay thế nội dung mâu thuẫn bên dưới. Chi tiết đối chiếu, API và vận hành tại [docs/DASHBOARD.md](../docs/DASHBOARD.md).

## 1. Bối cảnh

Discord CrossTalk Bot đã triển khai thành công mô hình 3 team/15 người, trong đó leader được relay giọng đến các team khác trong cùng nhóm, member chỉ giao tiếp nội bộ. Hệ thống đang mở rộng thành nhiều **Relay Groups** độc lập, quản lý leader bằng slash commands, và bổ sung **Mass Voice Move**.

Dashboard là giao diện quản trị qua trình duyệt để quản lý các chức năng này tập trung, dễ quan sát và thao tác hơn. Slash commands tiếp tục hoạt động, đồng bộ dữ liệu và quyền với dashboard.

## 2. Mục tiêu

1. Đăng nhập bằng tài khoản Discord.
2. Chọn Discord server (guild) mà người dùng có quyền quản trị và bot đã tham gia.
3. Xem trạng thái bot, Relay Groups, team, leader và người đang trong voice channel.
4. Tạo/sửa/xóa/tạm dừng Relay Groups và team theo quyền được cấp.
5. Quản lý leader ngay trên web, thay đổi có hiệu lực không cần redeploy.
6. Di chuyển hàng loạt người từ nhiều voice channel nguồn đến một channel đích bằng giao diện tích chọn.
7. Xem tiến trình, lỗi và lịch sử thao tác.
8. Không làm suy giảm độ ổn định, độ trễ hoặc khả năng chống echo của hệ thống relay đang chạy.

## 3. Phạm vi phiên bản đầu tiên (MVP)

**Bắt buộc:**

- Discord OAuth2 login/logout và phiên đăng nhập an toàn.
- Chọn guild; xác minh quyền phía server ở mọi request.
- Overview realtime hoặc gần realtime.
- Quản lý Relay Groups, teams, leader.
- Mass Voice Move với nguồn không giới hạn cố định, chọn một đích, preview và xác nhận.
- Trạng thái các bot clients và kết nối voice.
- Activity/Audit Logs.
- Đồng bộ cấu hình với slash commands hiện tại.
- Triển khai trên Railway và có tài liệu vận hành.

**Sau MVP:**

- Điều chỉnh âm lượng riêng từng leader/group (chỉ nếu relay engine hỗ trợ).
- Audio health metrics nâng cao (jitter, underrun, clipping).
- Preset di chuyển, lịch di chuyển, dashboard nhiều ngôn ngữ.
- Thông báo sự cố qua Discord hoặc hệ thống giám sát.

**Không thuộc phạm vi:**

- Thu âm/lưu giọng nói.
- Phát giọng qua trình duyệt.
- Thay thế Discord làm nền tảng voice.
- Di chuyển người xuyên Discord servers.
- Quản lý Discord bot token trực tiếp trên giao diện web.

## 4. Kiến trúc đề xuất

```text
Browser / Web Dashboard
        |
   HTTPS + Discord OAuth2
        |
Dashboard API / Authorization
        |
   Shared Service Layer
      /         \
Bot Control   Database
      |
Existing Discord Clients
      |
Existing Voice Relay Engine
```

- **Frontend:** Next.js.
- **API:** Node.js/TypeScript, tái sử dụng service nghiệp vụ hiện có.
- **Database:** PostgreSQL trên Railway hoặc database bền vững đang dùng; không thay thế tùy tiện dữ liệu hiện hữu.
- **Voice workers:** Giữ nguyên các bot accounts, mixer, receiver, reconnect logic.
- **Realtime:** WebSocket hoặc Server-Sent Events; fallback polling khi mất kết nối.
- **Hosting:** Ưu tiên Dashboard/API ở service Railway riêng với voice worker để tránh tải HTTP ảnh hưởng âm thanh. Có thể chạy chung process ở giai đoạn thử nghiệm nếu đo kiểm tài nguyên đạt yêu cầu.
- **Điều khiển xuyên service:** Nếu tách service, dùng kênh điều khiển có xác thực/queue phù hợp; **không chỉ ghi database rồi giả định worker tự nhận thay đổi**. Worker phải áp dụng cấu hình và trả trạng thái thực tế.

## 5. Vai trò và phân quyền

| Vai trò                 | Xem dashboard | Sửa group/team | Đổi leader     | Mass Voice Move | Quản lý quyền |
| ----------------------- | ------------- | -------------- | -------------- | --------------- | ------------- |
| Server Admin            | Có            | Có             | Có             | Có              | Có            |
| Operator được cấp quyền | Có            | Theo cấp quyền | Theo cấp quyền | Theo cấp quyền  | Không         |
| Viewer được cấp quyền   | Có            | Không          | Không          | Không           | Không         |
| Người dùng khác         | Không         | Không          | Không          | Không           | Không         |

- Đăng nhập qua Discord OAuth2, lấy danh sách guild mà người dùng có quyền phù hợp.
- **Backend phải xác minh lại** membership, quyền Discord và quyền nội bộ cho mỗi thao tác nhạy cảm.
- Không dựa vào việc ẩn nút frontend để bảo vệ API.
- Các quyền Discord liên quan gồm `Manage Guild`, `Move Members`, quyền voice và quyền quản trị phù hợp; cần kiểm tra đúng hành động.
- Hỗ trợ allowlist role cho Operator/Viewer, cấu hình bởi Admin.
- Không gửi bot token, OAuth secret hoặc thông tin nội bộ xuống browser.
- Áp dụng CSRF protection, cookie phiên `HttpOnly`/`Secure`/`SameSite`, HTTPS, rate limiting và kiểm tra `state` trong OAuth2.
- Log các thao tác quản trị; không log OAuth tokens hay nội dung âm thanh.

## 6. Trang Overview

Hiển thị:

- Guild đang chọn.
- Tổng Relay Groups, team, leader được gán.
- Tổng người trong các voice channel do Discord CrossTalk quản lý.
- Số bot clients online/offline, số voice connections đang hoạt động.
- Trạng thái từng group: `Active`, `Paused`, `Degraded`, `Offline`.
- Các cảnh báo: bot disconnect, thiếu quyền voice, thiếu bot account, leader ở sai channel, lỗi database.
- Hoạt động gần đây: thay leader, thêm/xóa team, mass move.

Trạng thái phải phản ánh **thực tế runtime**, không chỉ dữ liệu cấu hình trong database. Ghi rõ thời điểm cập nhật gần nhất.

## 7. Relay Groups Management

### 7.1 Danh sách groups

- Tên, ID, trạng thái, số team, số người trong voice, số leader online, trạng thái bot.
- Tìm kiếm/lọc theo trạng thái.

### 7.2 Thao tác

- Tạo group, đổi tên, xem chi tiết, pause/resume, xóa.
- Khi xóa, hiển thị số team bị ảnh hưởng và yêu cầu xác nhận.
- Không cho xóa group khi còn team trừ khi có luồng xóa rõ ràng, có xác nhận riêng.
- Group A hiện hữu phải được migrate an toàn và giữ nguyên cấu hình.

### 7.3 Cách ly âm thanh

- Audio của group này không được relay sang group khác.
- Pause group chỉ dừng relay của group đó.
- Không làm ảnh hưởng group khác khi đổi cấu hình.

## 8. Team / Voice Channel Management

- Thêm team vào group và chọn voice channel qua danh sách Discord.
- Xem/sửa tên hiển thị, channel, bot account được gán, leader và trạng thái kết nối.
- Chuyển team sang group khác chỉ khi người quản trị xác nhận và hệ thống có thể chuyển an toàn.
- Xóa team phải có xác nhận, ngắt kết nối bot tương ứng một cách có kiểm soát.
- Một voice channel chỉ thuộc một team/group.
- Một bot account không được phục vụ đồng thời hai voice channel trong cùng guild.
- Nếu hết bot accounts rảnh, báo lỗi và không thay đổi team đang hoạt động.

## 9. Leader Management — chỉ xem

- Hiển thị tất cả leader theo role `LEADER_ROLE_ID` và voice channel thực tế; nhiều leader/team.
- Tìm theo username/ID/team; phân biệt chưa xác minh với không có leader.
- Thêm/gỡ role trực tiếp trên Discord. Web không có API mutation leader và không yêu cầu Manage Roles.
- Đồng bộ với `/leader list`, `/leader show` và sự kiện thay đổi role/voice runtime; không cần restart.
- Giữ các bảng leader cũ để rollback, không dùng chúng làm nguồn quyết định relay.

## 10. Mass Voice Move — Giao diện Web

### 10.1 Chọn nguồn và đích

- Hiển thị tất cả voice channels mà bot có thể truy cập trong guild.
- Danh sách có checkbox, ô tìm kiếm, lọc theo Relay Group, chọn tất cả/bỏ chọn tất cả.
- **Không giới hạn cố định 3 hay 25 channel nguồn trên giao diện web**. Quy mô thực tế bị ràng buộc bởi số channel của guild, giới hạn vận hành và Discord API.
- Chọn đúng **một** channel đích qua dropdown/search.
- Không cho chọn channel đích trùng nguồn; hiển thị thông báo yêu cầu chỉnh sửa.
- Chỉ hỗ trợ voice channels thường trong MVP, không hỗ trợ Stage.
- Mặc định bỏ qua toàn bộ bot accounts để không di chuyển bot relay.

### 10.2 Preview

- Danh sách nguồn, channel đích, số người mỗi nguồn, tổng người đủ điều kiện.
- Hiển thị số bot bị loại trừ.
- Cảnh báo khi leader sẽ rời channel đang được gán; không tự sửa leader assignment.
- Kiểm tra quyền, sức chứa và tình trạng channel đích.
- Chỉ người có quyền `Move Members` và quyền Operator/Admin tương ứng được xác nhận.
- Snapshot danh sách người đủ điều kiện tại thời điểm preview; người vào sau không thuộc job.

### 10.3 Thực thi

- Bấm **Confirm Move** để tạo một job có ID duy nhất.
- Queue dùng chung di chuyển tuần tự; dừng khi lỗi, không retry tự động hoặc gửi lại request chưa rõ kết quả.
- Trước mỗi lần chuyển, kiểm tra người đó vẫn ở một trong các nguồn đã chọn.
- Không di chuyển lại người đã ở đích, đã rời nguồn hoặc là bot.
- Không tự rollback người đã chuyển khi một phần job thất bại.
- Chặn job trùng hoặc hai job đang chạy đồng thời trên cùng guild.
- Trả kết quả: thành công, bỏ qua, thất bại, nguyên nhân.
- Railway restart không được tự chạy lại toàn bộ job mù quáng.

### 10.4 Tương thích Slash Commands

- `/voice move-all` giữ giao diện hiện tại tối đa 25 nguồn, lựa chọn thay thế trực tiếp; web không mang giới hạn select menu này.
- Dashboard web và Discord command gọi **cùng một Mass Move Service** để thống nhất phân quyền, validation, queue và audit.
- Không tạo hai cách xử lý khác nhau có thể dẫn đến kết quả không nhất quán.

## 11. Bot Management & Voice Health

- Danh sách bot accounts theo tên/ID (không hiển thị token).
- Online/offline, guild, voice channel, team đang phục vụ, reconnect state.
- Thông báo bot không có quyền Connect/Speak/Move Members khi liên quan.
- Có thể cho phép thao tác reconnect bot cụ thể, với xác nhận và cooldown; không cho tùy ý đổi token trên web.
- Không cho phép thao tác khiến bot bị chiếm từ team khác ngoài ý muốn.
- Voice health nâng cao chỉ hiển thị nếu engine cung cấp metrics đáng tin cậy.

## 12. Activity Logs và Audit

Ghi tối thiểu:

- Actor Discord ID, guild ID, hành động, mục tiêu, thời gian, kết quả.
- Group/team/leader: trạng thái trước và sau.
- Mass Move: job ID, nguồn/đích, số thành công/bỏ qua/thất bại và nhóm lỗi.
- Sự cố bot: reconnect, disconnect, permission failures.

Cho phép lọc theo thời gian, actor, group và loại hành động. Chỉ người có quyền phù hợp được xem. Không lưu audio, nội dung hội thoại hoặc secrets.

## 13. Đồng bộ dữ liệu và độ tin cậy

- Cấu hình bền vững trong database; worker áp dụng thay đổi khi đang chạy.
- Slash commands và Dashboard cùng gọi service nghiệp vụ hoặc cùng một command bus.
- API phải trả cả **desired state** và **actual state** khi chúng khác nhau.
- Thao tác quan trọng có idempotency key, concurrency control và audit.
- Thay đổi group/team cần transaction hoặc cơ chế rollback hợp lý.
- Có cơ chế xử lý worker offline: báo trạng thái `Pending/Failed`, không thông báo “đã áp dụng” khi worker chưa xác nhận.
- Có migration dữ liệu an toàn cho Group A và các leader đã cấu hình.

## 14. Giao diện và trải nghiệm

Menu chính:

1. Overview
2. Relay Groups
3. Teams & Channels
4. Leaders
5. Mass Voice Move
6. Bots & Voice Health
7. Activity Logs
8. Settings & Permissions

Yêu cầu:

- Responsive trên desktop và mobile.
- Trạng thái tải/rỗng/lỗi rõ ràng.
- Các thao tác nguy hiểm có confirm dialog.
- Tên channel và username lấy từ Discord; xử lý trường hợp đổi tên hoặc bị xóa.
- Tìm kiếm, phân trang với guild lớn.
- Hiển thị thời điểm dữ liệu được cập nhật.
- Không tự động thực hiện tác vụ nguy hiểm chỉ vì mở trang.

## 15. API và các luồng nghiệp vụ (mức khái niệm)

| Nhóm API  | Chức năng                                     |
| --------- | --------------------------------------------- |
| Auth      | Login callback, logout, session, guild access |
| Overview  | Tổng quan runtime, health, cảnh báo           |
| Groups    | List/create/update/pause/resume/delete        |
| Teams     | List/create/update/delete, bot assignment     |
| Leaders   | List runtime (chỉ xem)                               |
| Move Jobs | Preview/create/status/cancel phần chưa xử lý  |
| Bots      | List/status/reconnect (nếu được cấp quyền)    |
| Audit     | List/filter                                   |
| Settings  | Permissions/roles                             |

Không trả secrets; xác thực và kiểm tra quyền ở từng endpoint. Các thay đổi phải phản ánh trong Discord bot engine và database.

## 16. Railway Deployment

**Khuyến nghị production:**

- Service 1: `Discord CrossTalk-voice-worker` — giữ nguyên bot clients và relay engine.
- Service 2: `Discord CrossTalk-dashboard` — frontend và API.
- PostgreSQL: cấu hình và audit; kênh điều khiển đáng tin cậy giữa API và worker.
- Cấu hình public HTTPS domain cho Dashboard và Discord OAuth2 redirect URI.
- CORS và cookie session cấu hình đúng domain; không công khai worker control endpoint.
- Các bot tokens chỉ nằm ở môi trường worker; OAuth client secret ở backend.
- Tránh scale nhiều replicas của voice worker với cùng bộ bot tokens/voice channels.
- Health checks, logs, backups, migration và rollback được chuẩn bị trước khi rollout.

Có thể thử nghiệm dashboard và worker cùng service nếu chưa cần tách, nhưng phải bảo đảm UI/API không làm gián đoạn âm thanh và có kế hoạch tách khi tải tăng.

## 17. Lộ trình triển khai

**Giai đoạn 1 — Nền tảng:** Rà soát code hiện có, database migration, Discord OAuth2, phân quyền, shared service layer, trang Overview.

**Giai đoạn 2 — Quản trị:** Relay Groups, Teams, Leaders, bot status, đồng bộ Slash Commands.

**Giai đoạn 3 — Mass Move:** Chọn nhiều nguồn, preview, confirm, job queue, progress, audit.

**Giai đoạn 4 — Production:** Test tải và lỗi, hardening bảo mật, Railway deploy, giám sát, rollback.

Không được thay thế engine audio đang hoạt động bằng code mới khi chưa có bằng chứng cần thiết.

## 18. Acceptance Criteria

| ID    | Tiêu chí nghiệm thu                                                               |
| ----- | --------------------------------------------------------------------------------- |
| AC-01 | Đăng nhập Discord thành công; người không có quyền không vào được dashboard guild |
| AC-02 | Người có quyền chỉ thấy các guild hợp lệ                                          |
| AC-03 | Overview phản ánh đúng số group/team/leader và trạng thái bot                     |
| AC-04 | Tạo/sửa/pause/resume group không ảnh hưởng group khác                             |
| AC-05 | Ba team cũ Group A hoạt động y như trước khi có dashboard                         |
| AC-06 | Không thể gán cùng channel vào hai team                                           |
| AC-07 | Không thể gán bot account vào hai channel cùng guild đồng thời                    |
| AC-08 | Leaders chỉ xem phản ánh role/voice runtime mà không restart                                  |
| AC-09 | Thay đổi role Leader trên Discord được cập nhật trên dashboard                         |
| AC-10 | Mass Move chọn được trên 25 nguồn qua checkbox/search nếu guild có đủ channel     |
| AC-11 | Preview Mass Move hiển thị nguồn/đích và tổng người đúng tại thời điểm snapshot   |
| AC-12 | Mass Move không di chuyển bất kỳ bot account nào                                  |
| AC-13 | Job báo kết quả thành công/bỏ qua/thất bại chính xác                              |
| AC-14 | Người không có quyền Move Members không thể xác nhận move                         |
| AC-15 | Nhấn xác nhận hai lần không tạo hai job                                           |
| AC-16 | Một lỗi Discord API không làm hỏng relay đang chạy                                |
| AC-17 | Dashboard không làm âm thanh rò rỉ giữa các Relay Groups                          |
| AC-18 | Logs ghi nhận ai đã thay đổi cấu hình và thực hiện move                           |
| AC-19 | Railway restart khôi phục cấu hình, không tự lặp job move đã thực thi             |
| AC-20 | Dashboard hiển thị rõ khi worker offline, không báo thao tác đã áp dụng sai       |
| AC-21 | Không có bot token/OAuth secret trong response, log hoặc frontend bundle          |
| AC-22 | Dashboard dùng được trên màn hình desktop và mobile                               |
| AC-23 | Bot voice vẫn hoạt động khi dashboard tạm ngừng                                   |
| AC-24 | Có quy trình backup, rollback và test trước khi áp dụng production                |

## 19. Definition of Done

Dashboard được coi là hoàn thành khi người quản trị có thể đăng nhập bằng Discord, chọn server, xem trạng thái hệ thống, quản lý Relay Groups/Teams/Leaders, thực hiện Mass Voice Move, xem audit và sử dụng song song với các slash commands. Tất cả thao tác có phân quyền và kết quả phản ánh runtime thực tế. Voice Relay Engine và Group A đang hoạt động thành công phải giữ nguyên hành vi, không có relay chéo group hoặc bot bị chuyển ngoài ý muốn.

## 20. Chỉ dẫn dành cho AI Coding Agent

1. **Đọc và phân tích source code hiện có trước khi thay đổi.**
2. Lập bảng đối chiếu tính năng đang chạy với các mục spec; không giả định mọi tính năng đề xuất đã được implement.
3. Tái sử dụng logic quản lý group/team/leader và Mass Move hiện có; không tạo hệ thống song song.
4. Giữ tương thích dữ liệu và slash commands; chuẩn bị database migration.
5. Tách quyền frontend/backend và thực thi Discord API tại backend.
6. Thực hiện thay đổi theo từng module, kèm unit/integration tests.
7. Test trên guild riêng trước khi deploy Railway production.
8. Báo rõ tính năng nào đã hoàn tất, tính năng nào cần Discord bot permissions, OAuth credentials hoặc cấu hình Railway.

---

**Tài liệu liên quan:** `Discord CrossTalk_MULTI_RELAY_GROUPS_UPGRADE.md`, `Discord CrossTalk_MASS_VOICE_MOVE_SPEC.md`. Khi có mâu thuẫn, ưu tiên các quy tắc an toàn và tương thích ngược với hệ thống đang chạy, đồng thời yêu cầu xác nhận trước khi thay đổi hành vi nghiệp vụ.
