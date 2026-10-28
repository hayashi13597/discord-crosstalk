# Discord CrossTalk Bot — Đặc tả tính năng

**Mục đích:** Mô tả đầy đủ yêu cầu và cách hoạt động của hệ thống truyền giọng nói giữa các team trong một Discord server.
**Phạm vi:** Tài liệu tính năng.

## 1. Tổng quan

CrossTalk Bot là hệ thống giúp các leader giao tiếp bằng giọng nói với các team khác trong khi các thành viên vẫn giữ kênh voice riêng của team mình. Hệ thống chỉ chuyển tiếp giọng nói của leader được chỉ định; giọng nói của member không được chuyển ra ngoài team.

Hệ thống được thiết kế cho **15 người**, chia thành **3 team**. Mỗi team gồm **1 leader và 4 member**, tham gia **1 voice channel riêng biệt** trong cùng một Discord server.

### Mục tiêu

- Leader nói tự nhiên trong voice channel của mình; **không cần ra lệnh hoặc nhấn nút broadcast**.
- Leader của bất kỳ team nào nói thì **hai team còn lại đều nghe được**.
- Member chỉ được nghe và nói chuyện trong team của mình; lời nói của member **không được phát sang các team khác**.
- Hỗ trợ **nhiều leader nói cùng lúc** bằng cách trộn âm thanh, không khóa quyền nói theo lượt.
- Hạn chế độ trễ, tránh tiếng lặp/tiếng vọng do bot tạo ra, tự phục hồi sau gián đoạn kết nối thông thường.
- Deploy và vận hành ba bot bằng **một Railway service**.
- **Thêm, xóa, xem và thay leader bằng slash command**; thay đổi có hiệu lực ngay, không cần restart hoặc redeploy.

## 2. Cấu trúc người dùng và kênh

| Team   | Voice channel   | Vai trò             | Bot tham gia |
| ------ | --------------- | ------------------- | ------------ |
| Team 1 | Voice Channel 1 | Leader 1 + 4 member | Bot 1        |
| Team 2 | Voice Channel 2 | Leader 2 + 4 member | Bot 2        |
| Team 3 | Voice Channel 3 | Leader 3 + 4 member | Bot 3        |

Ba bot account hoạt động phối hợp như **một hệ thống**. Mỗi bot vào một voice channel; toàn bộ hệ thống chạy trong **một ứng dụng / một Railway service**. Việc cần ba bot account xuất phát từ giới hạn mỗi bot account chỉ tham gia một voice channel trong cùng một server tại một thời điểm.

## 3. Quy tắc chuyển tiếp âm thanh

### 3.1. Leader

- **Leader 1 nói:** người ở Team 1 nghe trực tiếp qua Discord; Bot 1 chuyển lời của Leader 1 đến Team 2 và Team 3.
- **Leader 2 nói:** Team 2 nghe trực tiếp; Bot 2 chuyển lời đến Team 1 và Team 3.
- **Leader 3 nói:** Team 3 nghe trực tiếp; Bot 3 chuyển lời đến Team 1 và Team 2.
- **Không phát ngược giọng của leader về chính kênh nguồn** để tránh nghe tiếng bản thân bị trễ.

### 3.2. Member

- Member nói: những người cùng voice channel nghe như cuộc trò chuyện Discord thông thường.
- Hệ thống **không chuyển tiếp** lời member sang voice channel khác.
- Member vẫn nghe được lời leader từ hai team còn lại do bot tại channel mình phát ra.

### 3.3. Ma trận nghe

Dấu ✓ nghĩa là nghe được giọng nói của người đang nói; “Chỉ nội bộ” nghĩa là lời member không truyền sang team khác.

| Người nói     | Team 1 nghe  | Team 2 nghe  | Team 3 nghe  |
| ------------- | ------------ | ------------ | ------------ |
| Leader 1      | ✓ Trực tiếp  | ✓ Qua Bot 2  | ✓ Qua Bot 3  |
| Leader 2      | ✓ Qua Bot 1  | ✓ Trực tiếp  | ✓ Qua Bot 3  |
| Leader 3      | ✓ Qua Bot 1  | ✓ Qua Bot 2  | ✓ Trực tiếp  |
| Member Team 1 | ✓ Chỉ nội bộ | Không        | Không        |
| Member Team 2 | Không        | ✓ Chỉ nội bộ | Không        |
| Member Team 3 | Không        | Không        | ✓ Chỉ nội bộ |

## 4. Trộn âm thanh khi leader nói đồng thời

**Chế độ mặc định: Mix đồng thời (Always-on).**

- Mỗi team có thể nghe **tối đa hai leader từ hai team khác** phát qua bot trong voice channel của mình.
- Nếu hai leader bên ngoài cùng nói, bot tại team đích sẽ **trộn hai nguồn** thành một luồng phát.
- Giọng leader tại team đích vẫn được nghe **trực tiếp** qua Discord, không cần trộn lại với giọng của chính họ trong bot.
- Không tự động ngắt tiếng leader thứ hai hoặc giới hạn một người nói một thời điểm.
- Áp dụng kiểm soát mức âm lượng để giảm nguy cơ méo/clipping khi hai nguồn cùng lớn tiếng.
- Khi một leader im lặng hoặc rời kênh, luồng của người đó ngừng đóng góp vào âm thanh; luồng còn lại tiếp tục bình thường.

**Lưu ý trải nghiệm:** Nếu cả ba leader nói cùng lúc, mỗi team sẽ nghe leader team mình trực tiếp cộng với hai leader còn lại qua bot. Việc nhiều giọng chồng nhau vẫn có thể làm khó nghe dù hệ thống trộn đúng.

## 5. Lọc quyền phát giọng theo leader

- Mỗi team có **tối đa một Discord User ID** được cấp quyền leader đang hoạt động; team có thể tạm thời chưa có leader khi bị xóa.
- Hệ thống nhận diện người nói theo **Discord User ID**, không dựa vào tên hiển thị hoặc nickname.
- Chỉ xử lý và chuyển tiếp âm thanh thuộc User ID leader đã cấu hình cho team tương ứng.
- Nếu một thành viên không được cấp quyền leader cố gắng nói, âm thanh đó **không trở thành nguồn relay**.
- Leader được quản lý bằng slash command bởi người có quyền; không hardcode User ID trong source code hay yêu cầu chỉnh environment variables.
- Khi đổi hoặc xóa leader, nguồn audio của leader cũ phải ngừng relay ngay cả khi người đó vẫn đang nói; cập nhật nguồn mới mà không restart bot.

## 6. Ngăn lặp âm thanh và tiếng vọng do relay

- Chỉ lấy nguồn từ **người dùng leader hợp lệ**, không lấy âm thanh của bot account khác để làm nguồn relay.
- **Không chuyển tiếp một luồng đã được bot phát lại** sang voice channel khác lần nữa.
- **Không phát lại về kênh gốc** của leader.
- Mục tiêu là không tạo vòng lặp Bot 1 → Bot 2 → Bot 3 → Bot 1.
- Không thể cam kết triệt tiêu hoàn toàn tiếng vọng do micro, loa ngoài, thiết bị hoặc thiết lập âm thanh của người dùng gây ra.

## 7. Chất lượng và độ trễ

### Hành vi mong muốn

- Truyền giọng nói gần thời gian thực, tối ưu để leader phối hợp khi chơi game hoặc tổ chức hoạt động.
- Có hàng đợi âm thanh ngắn để cân bằng giữa độ mượt và độ trễ.
- Khi mạng chập chờn hoặc mất một vài gói tin, ưu tiên duy trì luồng tiếng và tránh tích tụ độ trễ ngày càng lớn.
- Tự loại bỏ dữ liệu audio quá cũ nếu không thể phát kịp thời gian thực.
- Khi một nguồn không có âm thanh, không phát tiếng rác hoặc tự tái sử dụng âm thanh cũ.

### Các giới hạn cần chấp nhận

- Không thể cam kết độ trễ bằng 0 hay không có gián đoạn trong mọi điều kiện mạng.
- Trộn nhiều giọng có thể gây giảm độ rõ, đặc biệt khi người dùng nói đồng thời với âm lượng lớn.
- Khả năng nhận/phát voice thực tế phụ thuộc giao thức và thư viện Discord tương thích tại thời điểm triển khai, bao gồm yêu cầu mã hóa voice hiện hành.

## 8. Tự động vận hành và phục hồi

- Khi dịch vụ khởi động, ba bot đăng nhập và tham gia ba voice channel đã chỉ định.
- Bot luôn ở đúng channel được phân công, không tự động chuyển sang channel do người dùng đang ở.
- Nếu bot mất voice connection hoặc kết nối bị ngắt, hệ thống thử kết nối lại.
- Khi leader rời rồi quay lại đúng channel, tính năng relay hoạt động lại mà không cần bật thủ công.
- Nếu một bot gặp lỗi, có thông tin trạng thái/lỗi để quản trị viên chẩn đoán; các bot khác cần được xử lý an toàn, tránh phát dữ liệu cũ.
- Khi dừng hoặc khởi động lại dịch vụ, hệ thống đóng các luồng âm thanh và kết nối gọn gàng.

## 9. Quản trị leader bằng slash command

### 9.1. Nguyên tắc

- **Không hardcode Leader ID.** Bot quản lý leader động ngay trong Discord thông qua slash command.
- **Mỗi team tối đa một leader tại một thời điểm.** Team không có leader thì không phát voice ra ngoài, nhưng vẫn nghe leader từ team khác.
- Chỉ người có quyền quản trị được thêm, xóa hoặc thay leader; người dùng thường không thể tự cấp quyền relay.
- Những thay đổi được áp dụng **ngay khi lệnh thành công** và được lưu bền vững qua các lần restart hoặc redeploy Railway.
- Lệnh quản trị cần phản hồi riêng (ephemeral) khi thích hợp, nhất là lúc không đủ quyền hoặc ID không hợp lệ.

### 9.2. Danh sách lệnh đề xuất cho MVP

| Slash command                           | Chức năng                                                | Quy tắc                                           |
| --------------------------------------- | -------------------------------------------------------- | ------------------------------------------------- |
| `/leader set team:<1\|2\|3> user:@user` | Thêm leader cho team trống **hoặc thay leader hiện tại** | Ghi đè leader cũ; mỗi team luôn tối đa một leader |
| `/leader remove team:<1\|2\|3>`         | Gỡ quyền leader của team                                 | Dừng relay giọng của leader cũ ngay lập tức       |
| `/leader list`                          | Xem leader hiện tại của cả 3 team                        | Hiển thị team trống nếu chưa chỉ định leader      |
| `/leader show team:<1\|2\|3>`           | Xem leader của một team                                  | Chỉ tra cứu, không đổi cấu hình                   |
| `/status`                               | Xem trạng thái kết nối của 3 bot và khả năng relay       | Thông báo lỗi kết nối hoặc thiếu leader           |

Ví dụ thao tác: `/leader set team:1 user:@Alice` sẽ gán Alice làm Leader Team 1; `/leader remove team:1` sẽ thu hồi quyền relay; `/leader set team:1 user:@Bob` sẽ cấp lại cho Bob. Cách biểu diễn tùy thuộc giao diện slash command của Discord.

### 9.3. Phân quyền và xác thực

- Người có quyền **Manage Server (Manage Guild)** hoặc vai trò quản trị được cấu hình trước được sử dụng các lệnh thay đổi leader; có thể giới hạn chỉ Administrator nếu muốn chặt chẽ hơn.
- Kiểm tra quyền **ở phía bot mỗi lần nhận lệnh**, không chỉ dựa vào việc Discord có hiện nút/lệnh hay không.
- Chỉ chấp nhận User ID thuộc server hiện tại; từ chối bot account làm leader.
- Kiểm tra team hợp lệ (Team 1–3). Không tự thêm leader thứ hai cho cùng team.
- Nếu người được gán đang ở sai voice channel, quyền leader vẫn được lưu nhưng giọng của họ **không được relay** cho đến khi vào đúng channel của team.
- Khi người đang là leader ở Team 1 được gán làm leader cho Team 2, hệ thống từ chối thao tác (một tài khoản chỉ được làm leader cho một team) và yêu cầu gỡ phân công cũ trước.
- Lệnh có thể được gửi từ text channel phù hợp trong cùng Discord server; không bắt buộc người quản trị tham gia voice.

### 9.4. Lưu trữ cấu hình

- Bot token, Guild ID, Voice Channel ID vẫn được cung cấp qua biến môi trường Railway.
- **Leader ID không lưu trong biến môi trường.** Lưu trạng thái phân công `team → leader User ID` vào bộ lưu trữ có tính bền vững.
- Khuyến nghị MVP dùng **Railway PostgreSQL** (một dịch vụ database riêng trong project Railway), hoặc SQLite trên **Railway Volume** nếu muốn tránh database service. Không dùng file SQLite trên filesystem tạm của container vì có thể mất dữ liệu khi redeploy.
- Bot tự khôi phục danh sách leader từ kho dữ liệu lúc khởi động. Khi lần đầu chạy, cả ba team chưa có leader; quản trị viên dùng `/leader set` để phân công.
- Ghi nhận sự kiện thay đổi leader (team, người cũ, người mới, người thao tác, thời điểm) để tiện kiểm tra, **không lưu nội dung voice**.

### 9.5. Cấu hình vận hành khác

- Kích thước jitter buffer / lượng âm thanh đệm.
- Mức âm lượng khi trộn nhiều nguồn.
- Giới hạn hàng đợi để tránh tăng độ trễ lâu dài.
- Mức chi tiết của log vận hành.

**Yêu cầu MVP:** slash commands `/leader set`, `/leader remove`, `/leader list`, `/status`, phân quyền, hiệu lực tức thì và lưu leader bền vững. `/leader show` là lệnh tiện ích tùy chọn.

## 10. Triển khai trên Railway

- Chạy ba Discord bot account trong **một Railway service**, chung một ứng dụng xử lý relay.
- Dịch vụ được thiết kế chạy liên tục như background worker, **không yêu cầu website hoặc public domain** chỉ để nhận/phát voice.
- Cấu hình secrets/token bằng **environment variables**, không đưa token vào source code công khai.
- Sử dụng **một replica** cho cùng một bộ ba bot để tránh hai instance đồng thời cùng điều khiển voice connection.
- **Cần lưu trữ leader bền vững** (Railway PostgreSQL hoặc SQLite trên Railway Volume). Không cần Redis khi cả ba bot chạy chung process.
- Nhu cầu CPU, RAM, băng thông và chi phí Railway thực tế phải được đánh giá qua thử nghiệm tải; không có cam kết mức giá cố định.
- Không tự động lưu trữ bản ghi âm. Audio chỉ được xử lý trong bộ nhớ để chuyển tiếp thời gian thực.

## 11. Quyền Discord và an toàn vận hành

- Ba bot cần được mời vào server với quyền truy cập, kết nối và phát tiếng trong voice channel tương ứng.
- Cấp quyền bot theo nguyên tắc **tối thiểu cần thiết**; không cần quyền Administrator chỉ để relay giọng nói.
- Các bot phải có khả năng nhận và phát âm thanh tương thích với Discord voice tại thời điểm deploy.
- Chỉ sử dụng trong những kênh và cộng đồng mà người tham gia được thông báo về việc giọng leader có thể được truyền sang các team khác.
- Token bot là thông tin bí mật; nếu bị lộ phải thu hồi và tạo lại.

## 12. Các tình huống sử dụng

**Tình huống A — Một leader phát lệnh:** Leader 1 nói “Tập trung mục tiêu A”. Team 1 nghe trực tiếp, Team 2 và Team 3 nghe qua bot của mình.

**Tình huống B — Member trao đổi nội bộ:** Member Team 2 hỏi đồng đội về trang bị. Chỉ Team 2 nghe. Team 1 và Team 3 không nhận âm thanh này.

**Tình huống C — Hai leader cùng nói:** Leader 1 và Leader 3 cùng nói. Team 2 nghe cả hai giọng đã được trộn; Team 1 nghe Leader 3 qua bot và Leader 1 trực tiếp; Team 3 nghe Leader 1 qua bot và Leader 3 trực tiếp.

**Tình huống D — Cả ba leader cùng nói:** Trong mỗi channel, giọng leader nội bộ phát trực tiếp; bot phát hai giọng leader ở hai channel khác được trộn với nhau.

**Tình huống E — Leader mất kết nối:** Leader 2 rời voice. Không còn âm thanh Leader 2 để chuyển tiếp. Khi họ tham gia lại đúng channel, relay tiếp tục sau khi nguồn voice được khôi phục.

**Tình huống F — Một bot mất kết nối:** Team tương ứng có thể tạm thời không nghe được leader các team khác; hệ thống thử kết nối lại và khôi phục relay.

**Tình huống G — Thay leader bằng lệnh:** Quản trị viên dùng `/leader set team:1 user:@Bob` khi Team 1 đang có Alice. Bot ngừng relay Alice ngay khi lệnh thành công; chỉ giọng Bob được truyền từ Team 1 nếu Bob ở đúng channel.

**Tình huống H — Xóa leader:** Quản trị viên dùng `/leader remove team:2`. Giọng của bất kỳ ai trong Team 2 không còn phát sang Team 1/3; Team 2 vẫn nghe các leader khác.

**Tình huống I — Railway restart:** Bot tải danh sách leader đã lưu trước đó và tiếp tục relay theo cấu hình, không cần gọi lại lệnh `/leader set`.

## 13. Tiêu chí nghiệm thu MVP

- [ ] Cả 3 bot kết nối được vào đúng 3 voice channel trên cùng một server.
- [ ] Leader 1 được nghe tại cả 3 team, không bị bot phát lặp trong Team 1.
- [ ] Leader 2 được nghe tại cả 3 team, không bị bot phát lặp trong Team 2.
- [ ] Leader 3 được nghe tại cả 3 team, không bị bot phát lặp trong Team 3.
- [ ] Tất cả member chỉ phát tiếng trong team mình, không rò âm thanh qua hai team còn lại.
- [ ] Hai leader nói cùng lúc: team thứ ba nghe được cả hai luồng.
- [ ] Ba leader nói cùng lúc: mỗi team nghe leader nội bộ trực tiếp và hai leader bên ngoài qua bot.
- [ ] Không xuất hiện vòng lặp giữa các bot hoặc tự relay ngược về channel nguồn.
- [ ] Leader rời và vào lại channel: relay tự hoạt động lại.
- [ ] Bot mất kết nối voice tạm thời: có cơ chế phục hồi hoặc báo lỗi rõ ràng.
- [ ] Chạy liên tục trên một Railway service với một replica, secrets được cấu hình an toàn.
- [ ] Không tạo bản ghi âm hoặc lưu nội dung lời nói vào ổ đĩa.
- [ ] Quản trị viên thêm/thay leader bằng `/leader set` và bot chỉ chuyển giọng leader mới ngay lập tức.
- [ ] `/leader remove` lập tức chặn relay của leader đã xóa, các team khác vẫn hoạt động bình thường.
- [ ] `/leader list` hiển thị đúng leader của cả 3 team, kể cả team chưa có leader.
- [ ] Người không đủ quyền không thể thay đổi leader; không thể gán cùng một người cho nhiều team.
- [ ] Leader không nằm trong đúng voice channel không được relay.
- [ ] Leader đã thiết lập không bị mất sau khi restart/redeploy Railway.

## 14. Ngoài phạm vi MVP / có thể phát triển sau

- Tự động tạo team, sắp xếp người chơi hoặc di chuyển thành viên giữa các kênh.
- Push-to-talk / bật tắt broadcast theo yêu cầu.
- Hỗ trợ nhiều server Discord đồng thời.
- Thông số âm lượng riêng theo từng leader hoặc từng team.
- Ưu tiên giọng nói, voice activity detection và xử lý âm thanh nâng cao.
- Theo dõi số liệu chất lượng voice (độ trễ, mất gói, số lần reconnect) theo thời gian.

## 15. Kết luận

**Yêu cầu cốt lõi:** 3 team độc lập, mỗi team tối đa 1 leader và 4 member; chỉ leader được truyền giọng qua hai team khác; nhiều leader có thể nói đồng thời; bot trộn âm thanh, tránh vòng lặp; leader được quản trị động bằng slash command và lưu bền vững; ba bot account phối hợp trên một Railway service (kèm dịch vụ lưu trữ/volume nếu cần).

Tài liệu này mô tả **tính năng mục tiêu và tiêu chí nghiệm thu**, không khẳng định mọi chức năng đã được kiểm thử thành công trên Discord/Railway thực tế.

# Discord CrossTalk Bot — Đặc tả tính năng

**Phiên bản tài liệu:** 1.1
**Mục đích:** Mô tả đầy đủ yêu cầu và cách hoạt động của hệ thống truyền giọng nói giữa các team trong một Discord server.
**Phạm vi:** Tài liệu tính năng, không bao gồm source code hoặc hướng dẫn lập trình.

## 1. Tổng quan

CrossTalk Bot là hệ thống giúp các leader giao tiếp bằng giọng nói với các team khác trong khi các thành viên vẫn giữ kênh voice riêng của team mình. Hệ thống chỉ chuyển tiếp giọng nói của leader được chỉ định; giọng nói của member không được chuyển ra ngoài team.

Hệ thống được thiết kế cho **15 người**, chia thành **3 team**. Mỗi team gồm **1 leader và 4 member**, tham gia **1 voice channel riêng biệt** trong cùng một Discord server.

### Mục tiêu

- Leader nói tự nhiên trong voice channel của mình; **không cần ra lệnh hoặc nhấn nút broadcast**.
- Leader của bất kỳ team nào nói thì **hai team còn lại đều nghe được**.
- Member chỉ được nghe và nói chuyện trong team của mình; lời nói của member **không được phát sang các team khác**.
- Hỗ trợ **nhiều leader nói cùng lúc** bằng cách trộn âm thanh, không khóa quyền nói theo lượt.
- Hạn chế độ trễ, tránh tiếng lặp/tiếng vọng do bot tạo ra, tự phục hồi sau gián đoạn kết nối thông thường.
- Deploy và vận hành ba bot bằng **một Railway service**.
- **Thêm, xóa, xem và thay leader bằng slash command**; thay đổi có hiệu lực ngay, không cần restart hoặc redeploy.

## 2. Cấu trúc người dùng và kênh

| Team   | Voice channel   | Vai trò             | Bot tham gia |
| ------ | --------------- | ------------------- | ------------ |
| Team 1 | Voice Channel 1 | Leader 1 + 4 member | Bot 1        |
| Team 2 | Voice Channel 2 | Leader 2 + 4 member | Bot 2        |
| Team 3 | Voice Channel 3 | Leader 3 + 4 member | Bot 3        |

Ba bot account hoạt động phối hợp như **một hệ thống**. Mỗi bot vào một voice channel; toàn bộ hệ thống chạy trong **một ứng dụng / một Railway service**. Việc cần ba bot account xuất phát từ giới hạn mỗi bot account chỉ tham gia một voice channel trong cùng một server tại một thời điểm.

## 3. Quy tắc chuyển tiếp âm thanh

### 3.1. Leader

- **Leader 1 nói:** người ở Team 1 nghe trực tiếp qua Discord; Bot 1 chuyển lời của Leader 1 đến Team 2 và Team 3.
- **Leader 2 nói:** Team 2 nghe trực tiếp; Bot 2 chuyển lời đến Team 1 và Team 3.
- **Leader 3 nói:** Team 3 nghe trực tiếp; Bot 3 chuyển lời đến Team 1 và Team 2.
- **Không phát ngược giọng của leader về chính kênh nguồn** để tránh nghe tiếng bản thân bị trễ.

### 3.2. Member

- Member nói: những người cùng voice channel nghe như cuộc trò chuyện Discord thông thường.
- Hệ thống **không chuyển tiếp** lời member sang voice channel khác.
- Member vẫn nghe được lời leader từ hai team còn lại do bot tại channel mình phát ra.

### 3.3. Ma trận nghe

Dấu ✓ nghĩa là nghe được giọng nói của người đang nói; “Chỉ nội bộ” nghĩa là lời member không truyền sang team khác.

| Người nói     | Team 1 nghe  | Team 2 nghe  | Team 3 nghe  |
| ------------- | ------------ | ------------ | ------------ |
| Leader 1      | ✓ Trực tiếp  | ✓ Qua Bot 2  | ✓ Qua Bot 3  |
| Leader 2      | ✓ Qua Bot 1  | ✓ Trực tiếp  | ✓ Qua Bot 3  |
| Leader 3      | ✓ Qua Bot 1  | ✓ Qua Bot 2  | ✓ Trực tiếp  |
| Member Team 1 | ✓ Chỉ nội bộ | Không        | Không        |
| Member Team 2 | Không        | ✓ Chỉ nội bộ | Không        |
| Member Team 3 | Không        | Không        | ✓ Chỉ nội bộ |

## 4. Trộn âm thanh khi leader nói đồng thời

**Chế độ mặc định: Mix đồng thời (Always-on).**

- Mỗi team có thể nghe **tối đa hai leader từ hai team khác** phát qua bot trong voice channel của mình.
- Nếu hai leader bên ngoài cùng nói, bot tại team đích sẽ **trộn hai nguồn** thành một luồng phát.
- Giọng leader tại team đích vẫn được nghe **trực tiếp** qua Discord, không cần trộn lại với giọng của chính họ trong bot.
- Không tự động ngắt tiếng leader thứ hai hoặc giới hạn một người nói một thời điểm.
- Áp dụng kiểm soát mức âm lượng để giảm nguy cơ méo/clipping khi hai nguồn cùng lớn tiếng.
- Khi một leader im lặng hoặc rời kênh, luồng của người đó ngừng đóng góp vào âm thanh; luồng còn lại tiếp tục bình thường.

**Lưu ý trải nghiệm:** Nếu cả ba leader nói cùng lúc, mỗi team sẽ nghe leader team mình trực tiếp cộng với hai leader còn lại qua bot. Việc nhiều giọng chồng nhau vẫn có thể làm khó nghe dù hệ thống trộn đúng.

## 5. Lọc quyền phát giọng theo leader

- Mỗi team có **tối đa một Discord User ID** được cấp quyền leader đang hoạt động; team có thể tạm thời chưa có leader khi bị xóa.
- Hệ thống nhận diện người nói theo **Discord User ID**, không dựa vào tên hiển thị hoặc nickname.
- Chỉ xử lý và chuyển tiếp âm thanh thuộc User ID leader đã cấu hình cho team tương ứng.
- Nếu một thành viên không được cấp quyền leader cố gắng nói, âm thanh đó **không trở thành nguồn relay**.
- Leader được quản lý bằng slash command bởi người có quyền; không hardcode User ID trong source code hay yêu cầu chỉnh environment variables.
- Khi đổi hoặc xóa leader, nguồn audio của leader cũ phải ngừng relay ngay cả khi người đó vẫn đang nói; cập nhật nguồn mới mà không restart bot.

## 6. Ngăn lặp âm thanh và tiếng vọng do relay

- Chỉ lấy nguồn từ **người dùng leader hợp lệ**, không lấy âm thanh của bot account khác để làm nguồn relay.
- **Không chuyển tiếp một luồng đã được bot phát lại** sang voice channel khác lần nữa.
- **Không phát lại về kênh gốc** của leader.
- Mục tiêu là không tạo vòng lặp Bot 1 → Bot 2 → Bot 3 → Bot 1.
- Không thể cam kết triệt tiêu hoàn toàn tiếng vọng do micro, loa ngoài, thiết bị hoặc thiết lập âm thanh của người dùng gây ra.

## 7. Chất lượng và độ trễ

### Hành vi mong muốn

- Truyền giọng nói gần thời gian thực, tối ưu để leader phối hợp khi chơi game hoặc tổ chức hoạt động.
- Có hàng đợi âm thanh ngắn để cân bằng giữa độ mượt và độ trễ.
- Khi mạng chập chờn hoặc mất một vài gói tin, ưu tiên duy trì luồng tiếng và tránh tích tụ độ trễ ngày càng lớn.
- Tự loại bỏ dữ liệu audio quá cũ nếu không thể phát kịp thời gian thực.
- Khi một nguồn không có âm thanh, không phát tiếng rác hoặc tự tái sử dụng âm thanh cũ.

### Các giới hạn cần chấp nhận

- Không thể cam kết độ trễ bằng 0 hay không có gián đoạn trong mọi điều kiện mạng.
- Trộn nhiều giọng có thể gây giảm độ rõ, đặc biệt khi người dùng nói đồng thời với âm lượng lớn.
- Khả năng nhận/phát voice thực tế phụ thuộc giao thức và thư viện Discord tương thích tại thời điểm triển khai, bao gồm yêu cầu mã hóa voice hiện hành.

## 8. Tự động vận hành và phục hồi

- Khi dịch vụ khởi động, ba bot đăng nhập và tham gia ba voice channel đã chỉ định.
- Bot luôn ở đúng channel được phân công, không tự động chuyển sang channel do người dùng đang ở.
- Nếu bot mất voice connection hoặc kết nối bị ngắt, hệ thống thử kết nối lại.
- Khi leader rời rồi quay lại đúng channel, tính năng relay hoạt động lại mà không cần bật thủ công.
- Nếu một bot gặp lỗi, có thông tin trạng thái/lỗi để quản trị viên chẩn đoán; các bot khác cần được xử lý an toàn, tránh phát dữ liệu cũ.
- Khi dừng hoặc khởi động lại dịch vụ, hệ thống đóng các luồng âm thanh và kết nối gọn gàng.

## 9. Quản trị leader bằng slash command

### 9.1. Nguyên tắc

- **Không hardcode Leader ID.** Bot quản lý leader động ngay trong Discord thông qua slash command.
- **Mỗi team tối đa một leader tại một thời điểm.** Team không có leader thì không phát voice ra ngoài, nhưng vẫn nghe leader từ team khác.
- Chỉ người có quyền quản trị được thêm, xóa hoặc thay leader; người dùng thường không thể tự cấp quyền relay.
- Những thay đổi được áp dụng **ngay khi lệnh thành công** và được lưu bền vững qua các lần restart hoặc redeploy Railway.
- Lệnh quản trị cần phản hồi riêng (ephemeral) khi thích hợp, nhất là lúc không đủ quyền hoặc ID không hợp lệ.

### 9.2. Danh sách lệnh đề xuất cho MVP

| Slash command                           | Chức năng                                                | Quy tắc                                           |
| --------------------------------------- | -------------------------------------------------------- | ------------------------------------------------- |
| `/leader set team:<1\|2\|3> user:@user` | Thêm leader cho team trống **hoặc thay leader hiện tại** | Ghi đè leader cũ; mỗi team luôn tối đa một leader |
| `/leader remove team:<1\|2\|3>`         | Gỡ quyền leader của team                                 | Dừng relay giọng của leader cũ ngay lập tức       |
| `/leader list`                          | Xem leader hiện tại của cả 3 team                        | Hiển thị team trống nếu chưa chỉ định leader      |
| `/leader show team:<1\|2\|3>`           | Xem leader của một team                                  | Chỉ tra cứu, không đổi cấu hình                   |
| `/status`                               | Xem trạng thái kết nối của 3 bot và khả năng relay       | Thông báo lỗi kết nối hoặc thiếu leader           |

Ví dụ thao tác: `/leader set team:1 user:@Alice` sẽ gán Alice làm Leader Team 1; `/leader remove team:1` sẽ thu hồi quyền relay; `/leader set team:1 user:@Bob` sẽ cấp lại cho Bob. Cách biểu diễn tùy thuộc giao diện slash command của Discord.

### 9.3. Phân quyền và xác thực

- Người có quyền **Manage Server (Manage Guild)** hoặc vai trò quản trị được cấu hình trước được sử dụng các lệnh thay đổi leader; có thể giới hạn chỉ Administrator nếu muốn chặt chẽ hơn.
- Kiểm tra quyền **ở phía bot mỗi lần nhận lệnh**, không chỉ dựa vào việc Discord có hiện nút/lệnh hay không.
- Chỉ chấp nhận User ID thuộc server hiện tại; từ chối bot account làm leader.
- Kiểm tra team hợp lệ (Team 1–3). Không tự thêm leader thứ hai cho cùng team.
- Nếu người được gán đang ở sai voice channel, quyền leader vẫn được lưu nhưng giọng của họ **không được relay** cho đến khi vào đúng channel của team.
- Khi người đang là leader ở Team 1 được gán làm leader cho Team 2, hệ thống từ chối thao tác (một tài khoản chỉ được làm leader cho một team) và yêu cầu gỡ phân công cũ trước.
- Lệnh có thể được gửi từ text channel phù hợp trong cùng Discord server; không bắt buộc người quản trị tham gia voice.

### 9.4. Lưu trữ cấu hình

- Bot token, Guild ID, Voice Channel ID vẫn được cung cấp qua biến môi trường Railway.
- **Leader ID không lưu trong biến môi trường.** Lưu trạng thái phân công `team → leader User ID` vào bộ lưu trữ có tính bền vững.
- Khuyến nghị MVP dùng **Railway PostgreSQL** (một dịch vụ database riêng trong project Railway), hoặc SQLite trên **Railway Volume** nếu muốn tránh database service. Không dùng file SQLite trên filesystem tạm của container vì có thể mất dữ liệu khi redeploy.
- Bot tự khôi phục danh sách leader từ kho dữ liệu lúc khởi động. Khi lần đầu chạy, cả ba team chưa có leader; quản trị viên dùng `/leader set` để phân công.
- Ghi nhận sự kiện thay đổi leader (team, người cũ, người mới, người thao tác, thời điểm) để tiện kiểm tra, **không lưu nội dung voice**.

### 9.5. Cấu hình vận hành khác

- Kích thước jitter buffer / lượng âm thanh đệm.
- Mức âm lượng khi trộn nhiều nguồn.
- Giới hạn hàng đợi để tránh tăng độ trễ lâu dài.
- Mức chi tiết của log vận hành.

**Yêu cầu MVP:** slash commands `/leader set`, `/leader remove`, `/leader list`, `/status`, phân quyền, hiệu lực tức thì và lưu leader bền vững. `/leader show` là lệnh tiện ích tùy chọn.

## 10. Triển khai trên Railway

- Chạy ba Discord bot account trong **một Railway service**, chung một ứng dụng xử lý relay.
- Dịch vụ được thiết kế chạy liên tục như background worker, **không yêu cầu website hoặc public domain** chỉ để nhận/phát voice.
- Cấu hình secrets/token bằng **environment variables**, không đưa token vào source code công khai.
- Sử dụng **một replica** cho cùng một bộ ba bot để tránh hai instance đồng thời cùng điều khiển voice connection.
- **Cần lưu trữ leader bền vững** (Railway PostgreSQL hoặc SQLite trên Railway Volume). Không cần Redis khi cả ba bot chạy chung process.
- Nhu cầu CPU, RAM, băng thông và chi phí Railway thực tế phải được đánh giá qua thử nghiệm tải; không có cam kết mức giá cố định.
- Không tự động lưu trữ bản ghi âm. Audio chỉ được xử lý trong bộ nhớ để chuyển tiếp thời gian thực.

## 11. Quyền Discord và an toàn vận hành

- Ba bot cần được mời vào server với quyền truy cập, kết nối và phát tiếng trong voice channel tương ứng.
- Cấp quyền bot theo nguyên tắc **tối thiểu cần thiết**; không cần quyền Administrator chỉ để relay giọng nói.
- Các bot phải có khả năng nhận và phát âm thanh tương thích với Discord voice tại thời điểm deploy.
- Chỉ sử dụng trong những kênh và cộng đồng mà người tham gia được thông báo về việc giọng leader có thể được truyền sang các team khác.
- Token bot là thông tin bí mật; nếu bị lộ phải thu hồi và tạo lại.

## 12. Các tình huống sử dụng

**Tình huống A — Một leader phát lệnh:** Leader 1 nói “Tập trung mục tiêu A”. Team 1 nghe trực tiếp, Team 2 và Team 3 nghe qua bot của mình.

**Tình huống B — Member trao đổi nội bộ:** Member Team 2 hỏi đồng đội về trang bị. Chỉ Team 2 nghe. Team 1 và Team 3 không nhận âm thanh này.

**Tình huống C — Hai leader cùng nói:** Leader 1 và Leader 3 cùng nói. Team 2 nghe cả hai giọng đã được trộn; Team 1 nghe Leader 3 qua bot và Leader 1 trực tiếp; Team 3 nghe Leader 1 qua bot và Leader 3 trực tiếp.

**Tình huống D — Cả ba leader cùng nói:** Trong mỗi channel, giọng leader nội bộ phát trực tiếp; bot phát hai giọng leader ở hai channel khác được trộn với nhau.

**Tình huống E — Leader mất kết nối:** Leader 2 rời voice. Không còn âm thanh Leader 2 để chuyển tiếp. Khi họ tham gia lại đúng channel, relay tiếp tục sau khi nguồn voice được khôi phục.

**Tình huống F — Một bot mất kết nối:** Team tương ứng có thể tạm thời không nghe được leader các team khác; hệ thống thử kết nối lại và khôi phục relay.

**Tình huống G — Thay leader bằng lệnh:** Quản trị viên dùng `/leader set team:1 user:@Bob` khi Team 1 đang có Alice. Bot ngừng relay Alice ngay khi lệnh thành công; chỉ giọng Bob được truyền từ Team 1 nếu Bob ở đúng channel.

**Tình huống H — Xóa leader:** Quản trị viên dùng `/leader remove team:2`. Giọng của bất kỳ ai trong Team 2 không còn phát sang Team 1/3; Team 2 vẫn nghe các leader khác.

**Tình huống I — Railway restart:** Bot tải danh sách leader đã lưu trước đó và tiếp tục relay theo cấu hình, không cần gọi lại lệnh `/leader set`.

## 13. Tiêu chí nghiệm thu MVP

- [ ] Cả 3 bot kết nối được vào đúng 3 voice channel trên cùng một server.
- [ ] Leader 1 được nghe tại cả 3 team, không bị bot phát lặp trong Team 1.
- [ ] Leader 2 được nghe tại cả 3 team, không bị bot phát lặp trong Team 2.
- [ ] Leader 3 được nghe tại cả 3 team, không bị bot phát lặp trong Team 3.
- [ ] Tất cả member chỉ phát tiếng trong team mình, không rò âm thanh qua hai team còn lại.
- [ ] Hai leader nói cùng lúc: team thứ ba nghe được cả hai luồng.
- [ ] Ba leader nói cùng lúc: mỗi team nghe leader nội bộ trực tiếp và hai leader bên ngoài qua bot.
- [ ] Không xuất hiện vòng lặp giữa các bot hoặc tự relay ngược về channel nguồn.
- [ ] Leader rời và vào lại channel: relay tự hoạt động lại.
- [ ] Bot mất kết nối voice tạm thời: có cơ chế phục hồi hoặc báo lỗi rõ ràng.
- [ ] Chạy liên tục trên một Railway service với một replica, secrets được cấu hình an toàn.
- [ ] Không tạo bản ghi âm hoặc lưu nội dung lời nói vào ổ đĩa.
- [ ] Quản trị viên thêm/thay leader bằng `/leader set` và bot chỉ chuyển giọng leader mới ngay lập tức.
- [ ] `/leader remove` lập tức chặn relay của leader đã xóa, các team khác vẫn hoạt động bình thường.
- [ ] `/leader list` hiển thị đúng leader của cả 3 team, kể cả team chưa có leader.
- [ ] Người không đủ quyền không thể thay đổi leader; không thể gán cùng một người cho nhiều team.
- [ ] Leader không nằm trong đúng voice channel không được relay.
- [ ] Leader đã thiết lập không bị mất sau khi restart/redeploy Railway.

## 14. Ngoài phạm vi MVP / có thể phát triển sau

- Tự động tạo team, sắp xếp người chơi hoặc di chuyển thành viên giữa các kênh.
- Push-to-talk / bật tắt broadcast theo yêu cầu.
- Hỗ trợ nhiều server Discord đồng thời.
- Thông số âm lượng riêng theo từng leader hoặc từng team.
- Ưu tiên giọng nói, voice activity detection và xử lý âm thanh nâng cao.
- Theo dõi số liệu chất lượng voice (độ trễ, mất gói, số lần reconnect) theo thời gian.

## 15. Kết luận

**Yêu cầu cốt lõi:** 3 team độc lập, mỗi team tối đa 1 leader và 4 member; chỉ leader được truyền giọng qua hai team khác; nhiều leader có thể nói đồng thời; bot trộn âm thanh, tránh vòng lặp; leader được quản trị động bằng slash command và lưu bền vững; ba bot account phối hợp trên một Railway service (kèm dịch vụ lưu trữ/volume nếu cần).

Tài liệu này mô tả **tính năng mục tiêu và tiêu chí nghiệm thu**, không khẳng định mọi chức năng đã được kiểm thử thành công trên Discord/Railway thực tế.
