# Discord CrossTalk Bot — Feature Specification: Mass Voice Move

**Hệ thống nền:** Discord CrossTalk Bot đã vận hành thành công với 3 team/15 người và đang mở rộng theo mô hình Multiple Relay Groups.
**Mức ưu tiên:** MVP

## 1. Mục tiêu

Bổ sung slash command cho phép người có quyền **di chuyển toàn bộ thành viên đang kết nối trong nhiều voice channel nguồn được chỉ định sang một voice channel đích** trong cùng Discord server, bằng một lần thực thi.

Ví dụ: chuyển mọi thành viên từ **Voice A + Voice B + Voice C → Voice D**. Tính năng hỗ trợ tập hợp người chơi trước/sau trận, họp chung, hoặc chuyển từ phòng thi đấu về phòng chờ.

Đây là thao tác **di chuyển người dùng Discord**, không phải chức năng chuyển tiếp âm thanh. Không thay đổi leader, team hay Relay Group trong database.

## 2. Phạm vi

### MVP (bắt buộc)

- Chỉ hỗ trợ voice channel thông thường trong cùng một guild; không hỗ trợ chuyển qua server khác.
- Chọn **1–25 channel nguồn** trực tiếp qua giao diện tương tác Discord và **1 channel đích**; không tích lũy qua nhiều lượt.
- Di chuyển tất cả **người dùng thực** đang có mặt ở các channel nguồn tại thời điểm chụp danh sách.
- Mặc định **không di chuyển bot accounts**, bao gồm cả các bot Discord CrossTalk; không làm thay đổi kết nối bot phục vụ Voice Relay.
- Người có quyền có thể di chuyển cả leader lẫn member, không phân biệt Relay Group.
- Thao tác chạy theo từng người; gặp lỗi đầu tiên thì dừng trước người tiếp theo, không tự thử lại, giữ kết quả đã thành công.
- Không di chuyển người vốn đã ở channel đích.
- Có xác nhận trước khi di chuyển và log hoạt động phục vụ kiểm tra.

### Chưa thuộc MVP

- Hẹn giờ chuyển người, chuyển định kỳ, chuyển liên server.
- Di chuyển Stage Channel hoặc xử lý quy tắc speaker/audience của Stage.
- Di chuyển theo role, di chuyển ngược hoặc undo tự động.
- Di chuyển bot relay hoặc tự cấu hình lại vị trí bot.

## 3. Định nghĩa command và giao diện tương tác

**Command chính:** `/voice move-all` (không cần nhập từng `from_1`, `from_2`, `from_3` hay `to` ngay trên dòng command).

Sau khi gọi command trong server, bot mở **bảng điều khiển riêng tư (ephemeral)** dùng các thành phần tương tác Discord. Đây là giao diện **Channel Select Menu + Buttons**, không phải cửa sổ web tùy biến.

| Thành phần | Mô tả |
| ---------- | ----- |
| **Voice nguồn** | Multi-select 1–25 voice channel; sửa menu thay thế trực tiếp lựa chọn |
| **Voice đích** | Single-select đúng một voice channel |
| **Xác nhận** | Bật khi có nguồn và đích; kiểm tra, chụp snapshot rồi chạy ngay |
| **Hủy** | Kết thúc phiên, không chuyển ai |

Nội dung bảng chỉ là **Mass Voice Move**. Không có nút thêm/xóa nguồn, danh sách, xem trước, quay lại hoặc phân trang trong bảng thao tác. Tối đa 25 nguồn cho mỗi tác vụ.

**Ví dụ:** chạy `/voice move-all`, chọn `#Voice-A`, `#Voice-B`, `#Voice-C`, chọn `#Voice-D` làm đích rồi bấm **Xác nhận**.

**Tùy chọn phát triển sau:** `/voice move-group group:Alpha to:#Lobby` tự chọn các channel trong một Relay Group; không thuộc phạm vi MVP.

## 4. Luồng sử dụng

1. Người có quyền gọi `/voice move-all`; bot kiểm tra quyền ban đầu và mở phiên riêng tư.
2. Người dùng chọn 1–25 nguồn và một đích qua hai Channel Select lọc **Guild Voice**. Thay đổi menu cập nhật trực tiếp, không tích lũy nguồn.
3. Bấm **Xác nhận**; bot khóa phiên chống bấm lặp, gỡ thành phần tương tác và hiển thị **Đang chuyển…**.
4. Bot kiểm tra quyền, loại channel, nguồn khác đích và sức chứa; chụp snapshot người thật, loại bot và ID trùng. Lỗi tại bước này đóng phiên và báo lỗi, không chuyển ai.
5. Tạo đúng một job trước khi chuyển; kiểm tra lại điều kiện từng người rồi xử lý tuần tự. Lỗi đầu tiên dừng toàn bộ phần còn lại, không retry kể cả HTTP 429.
6. Thành công hiển thị số người đã chuyển/bỏ qua. Lỗi hiển thị nguyên nhân ngắn gọn, số đã chuyển và Job ID. Không có nút ở kết quả; chi tiết/phân trang qua `/voice move-status`.
7. Hủy hoặc hết hạn trước khi chạy không chuyển ai. Khi đã xác nhận không có hủy/undo.

**Quy ước snapshot:** chụp khi xác nhận. Chỉ người có mặt trong nguồn lúc chụp được đưa vào job; người mới vào sau snapshot không được tự thêm, người đã rời nguồn trước lượt xử lý được bỏ qua. Snapshot phải dưới 60 giây khi bắt đầu chạy.

**Thời hạn phiên:** 10 phút tuyệt đối từ lúc mở; đổi lựa chọn không gia hạn. Hết hạn trong khi chụp/kiểm tra cũng không được bắt đầu chuyển. Không có màn xác nhận thứ hai hoặc bộ đếm 60 giây cho người dùng.

## 5. Quy tắc nghiệp vụ

1. Có từ 1 đến 25 channel nguồn cho mỗi tác vụ.
2. Loại trùng channel nguồn theo ID; channel đích không được nằm trong tập nguồn. Vi phạm khi xác nhận thì báo lỗi và đóng phiên.
3. Tính năng chỉ di chuyển thành viên **đang kết nối voice**, không mời/kéo người offline vào voice.
4. Mặc định bỏ qua mọi bot account (không chỉ 6 bot Discord CrossTalk), bảo đảm hệ thống relay giữ nguyên vị trí. Không cung cấp tùy chọn di chuyển bot trong MVP.
5. Không thay đổi cấu hình leader, các Relay Group, thông số audio, quyền channel hoặc role của user.
6. Cho phép chọn nguồn từ nhiều Relay Group khác nhau, nhưng việc di chuyển không gộp Relay Groups về mặt cấu hình. Sau khi di chuyển, leader không còn ở channel gốc thì relay tương ứng có thể tạm ngừng nhận tiếng leader theo quy tắc đã có.
7. Không di chuyển một user hai lần trong cùng một tác vụ.
8. Không tự di chuyển user trở lại phòng cũ khi có một phần tác vụ thất bại; báo cáo trạng thái từng user và cho phép quản trị viên quyết định xử lý tiếp.
9. Mỗi guild chỉ được có **một tác vụ Mass Voice Move đang thực thi** tại một thời điểm để tránh đua trạng thái; lượt thứ hai được từ chối với thông báo rõ ràng.
10. Không có bước xác nhận bổ sung. Xử lý tuần tự và dừng ngay khi gặp lỗi; không tự thử lại HTTP 429, timeout hoặc 5xx.

## 6. Phân quyền và bảo mật

- Người gọi phải có quyền Discord **Move Members** trong guild và thuộc nhóm vai trò quản trị được cho phép sử dụng command (quy tắc mặc định: `Manage Guild` hoặc `Administrator`; có thể mở rộng allowlist role sau).
- Bot account xử lý command cần quyền **Move Members** và quyền **Connect** với channel đích, đồng thời phải tuân thủ các kiểm tra quyền liên quan của Discord.
- Kiểm tra quyền lúc mở bảng, khi xác nhận và trước khi bắt đầu thực thi; không tin vào trạng thái đã kiểm tra trước đó.
- Bảng chọn, xác nhận và kết quả chi tiết hiển thị **ephemeral** để tránh spam text channel và lộ danh sách người dùng không cần thiết.
- Chỉ người gọi được thao tác với phiên. Phiên chọn nguồn có thời hạn tuyệt đối **10 phút** và không được tự chuyển ai.
- Chặn hành động ngoài guild hoặc yêu cầu không hợp lệ; không cần quyền đọc nội dung tin nhắn.

**Lưu ý Discord API:** Di chuyển user được thực hiện qua thao tác cập nhật `channel_id` của guild member; API yêu cầu quyền `MOVE_MEMBERS` và `CONNECT` đối với kênh đích. Discord cũng áp dụng rate limit, vì vậy không đảm bảo mọi người được chuyển cùng một thời điểm tuyệt đối.

## 7. Xử lý giới hạn và lỗi

| Tình huống                                            | Hành vi mong muốn                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Channel nguồn trống                                   | Bỏ qua nguồn trống; nếu tất cả nguồn trống/toàn bot thì xác nhận báo lỗi và đóng phiên                         |
| Trùng channel nguồn hoặc nguồn = đích                 | Tự loại trùng nguồn; nếu đích nằm trong tập nguồn thì xác nhận báo lỗi và đóng phiên                       |
| Bot hoặc người gọi thiếu quyền                        | Không chạy; chỉ rõ quyền còn thiếu                                                                     |
| Đích đầy/giới hạn người tham gia hoặc bị chặn Connect | Không cố vượt giới hạn; ghi nhận thất bại và lý do                                                     |
| User tự rời/chuyển voice khi đang chạy                | Bỏ qua nếu không còn trong nguồn được chọn; không kéo từ channel khác                                  |
| User bị Discord từ chối di chuyển                     | Ghi thất bại riêng cho user và dừng trước người tiếp theo                                          |
| Discord rate limit (HTTP 429)                         | Ghi thất bại `rate_limited`, dừng tác vụ ngay, không chờ hoặc retry                      |
| Một số người đã chuyển thành công trước khi lỗi       | Không rollback tự động; báo kết quả một phần                                                           |
| Tác vụ bị chạy trùng                                  | Từ chối tác vụ mới khi tác vụ cũ đang thực thi                                                         |
| Chọn trên 25 nguồn                                    | Menu giới hạn 25 nguồn; handler từ chối yêu cầu vượt giới hạn                            |
| Phiên chọn nguồn hết hạn hoặc channel bị xóa          | Báo lỗi/đóng phiên, yêu cầu mở lại lệnh; không tự thực thi                                              |
| Railway restart giữa tác vụ                           | Không chạy lại cả tác vụ một cách mù quáng; ghi trạng thái bị gián đoạn và đối soát trước khi chạy lại |

**Giới hạn đích:** kiểm tra giới hạn người dùng và quyền Connect trước khi chuyển, đồng thời xử lý trường hợp Discord từ chối ở thời điểm thực thi do trạng thái thay đổi. Không cam kết có thể ép toàn bộ người vào channel đã đầy.

**Lỗi tiến độ/audit:** lỗi gửi tiến độ, đọc hoặc ghi audit đều dừng các lượt tiếp theo. Cố ghi `Interrupted` và gửi thông báo lỗi; nếu database vẫn lỗi thì job có thể giữ `Running` để phục hồi khi restart. Lượt có kết quả chưa rõ giữ `unknown`, không tự gửi lại. Các lượt chưa xử lý được kết thúc theo cơ chế gián đoạn hiện có.

## 8. Tương thích Discord CrossTalk V2 / Multi Relay Groups

- Feature này nằm trong **module quản trị voice**, tách biệt với voice receiver, mixer và relay router.
- Có thể dùng nguồn là bất kỳ voice channel hợp lệ trong server, không cần thuộc Relay Group.
- Nếu chọn các channel đang có Bot 1–6, bot chỉ chuyển người dùng thực; các bot tiếp tục ở lại phòng cũ.
- Nếu leader bị chuyển khỏi voice channel đã gán, hệ thống relay phải dừng phát tiếng người đó từ team cũ theo logic sẵn có; khi leader quay lại đúng channel, relay hoạt động lại.
- Không sửa hoặc xóa mapping group/team/leader trong database do tác vụ di chuyển.
- Railway vẫn dùng một service hiện tại; không yêu cầu tạo thêm bot account hay service riêng cho tính năng này.
- Có thể dùng **một bot quản trị** (ví dụ bot account chính đã được chọn trước) để đăng ký và tiếp nhận command nhằm tránh 3–6 bot cùng hiện slash command giống nhau.

## 9. Báo cáo và audit log

Bảng thực thi chỉ hiển thị số đã chuyển/bỏ qua khi thành công; lỗi hiện nguyên nhân ngắn gọn, số đã chuyển và Job ID. Chi tiết qua `/voice move-status job:<id>` gồm người gọi/guild, thời gian, nguồn/đích, snapshot, số lượng và kết quả từng người.

Job mới kết thúc bằng `Completed`, `Cancelled` hoặc `Interrupted`; trạng thái lịch sử `Partially Completed` và `Failed` vẫn được tra cứu. Khi lỗi giữa chừng, giữ nguyên người đã chuyển và nguyên nhân của lượt lỗi, kết thúc phần chưa xử lý theo cơ chế repository hiện có. Không cần migration database.

Audit log nên lưu trong nơi lưu trữ bền vững đang dùng cho Discord CrossTalk, không chỉ trong bộ nhớ process; đặt thời gian lưu giữ phù hợp và tránh ghi token hay nội dung hội thoại.

## 10. Yêu cầu phi chức năng

- **Tính chính xác:** chỉ di chuyển đúng user nằm trong snapshot từ các nguồn đã chọn và vẫn ở nguồn khi xử lý.
- **An toàn:** không đụng bot accounts hoặc cấu hình Relay Group.
- **Khả năng phục hồi:** dừng ngay khi lỗi; một user thất bại không làm mất kết quả đã lưu của các user trước đó.
- **Hiệu năng:** xử lý có hàng đợi, không chặn Voice Relay realtime trong cùng process.
- **Trải nghiệm:** phản hồi command nhanh bằng cơ chế deferred interaction nếu cần; chỉ hai menu nguồn/đích và hai nút Xác nhận/Hủy; tiến độ/kết quả ngắn gọn, chi tiết phân trang qua lệnh trạng thái.
- **Idempotency:** mỗi thao tác xác nhận chỉ khởi tạo tối đa một tác vụ; tránh xử lý nhiều lần khi nhấn nút liên tiếp.

## 11. Kịch bản kiểm thử / tiêu chí nghiệm thu

| ID    | Kịch bản                                         | Kết quả mong đợi                                                                 |
| ----- | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| AC-01 | A có 5, B có 4, C có 6 user; D trống             | 15 user thật được chuyển sang D, 0 ở A/B/C nếu không ai rời giữa chừng           |
| AC-02 | A/B/C có bot Discord CrossTalk                   | Chỉ người thật chuyển, bot vẫn ở channel cũ                                      |
| AC-03 | A/B/C có leader và member                        | Cả leader/member đều được chuyển, không sửa leader assignment                    |
| AC-04 | A và B thuộc Group A; C thuộc Group B            | Chuyển được người ở cả 3 nguồn, không gộp cấu hình group                         |
| AC-05 | Người không có quyền gọi command                 | Bị từ chối, không user nào di chuyển                                             |
| AC-06 | Chọn trùng nguồn hoặc nguồn = đích               | Nguồn trùng được loại theo ID; nguồn = đích báo lỗi, đóng phiên                  |
| AC-07 | Một nguồn trống                                  | Các nguồn còn lại vẫn được xử lý đúng                                            |
| AC-08 | User rời nguồn sau snapshot                       | User đó được bỏ qua, không kéo từ chỗ mới                                        |
| AC-09 | Đích không đủ chỗ hoặc thiếu quyền               | Báo rõ thất bại; không tuyên bố hoàn tất 100%                                    |
| AC-10 | Discord API trả lỗi cho 1 user                   | Dừng trước user tiếp theo, giữ kết quả đã thành công                                 |
| AC-11 | Người dùng nhấn nút xác nhận 2 lần               | Không tạo hai tác vụ                                                             |
| AC-12 | Tác vụ thứ hai chạy khi tác vụ đầu chưa xong     | Bị chặn rõ ràng                                                                  |
| AC-13 | Hủy hoặc hết hạn phiên                        | Không chuyển ai                                                                  |
| AC-14 | Sau khi chuyển leader ra khỏi channel team       | Relay không lấy tiếng leader đó từ channel mới một cách ngoài ý muốn             |
| AC-15 | Railway restart và khởi chạy lại                 | Không tự động di chuyển lại hàng loạt người                                      |
| AC-16 | Chuyển xong và kiểm tra audit                    | Có bản ghi đầy đủ tổng kết và kết quả                                            |
| AC-17 | Chọn 4–25 nguồn qua menu                         | Mọi nguồn được lưu và xử lý, không bị giới hạn 3                                 |
| AC-18 | Yêu cầu chọn hơn 25 nguồn             | Menu giới hạn 25; handler từ chối yêu cầu vượt giới hạn                                   |
| AC-19 | Thay đổi nguồn/đích trực tiếp qua menu        | Lựa chọn được thay thế; không chuyển nguồn đã bỏ chọn                  |
| AC-20 | Phiên hết hạn giữa bước chọn hoặc trước xác nhận | Không thành viên nào bị chuyển                                                   |
| AC-21 | Chọn đích cũng nằm trong nguồn                   | Xác nhận báo lỗi, đóng phiên và không chuyển ai                                            |
| AC-22 | Hai group relay đang hoạt động song song         | Chỉ thay đổi vị trí người đã chọn, không phá cấu hình/voice relay của group khác |

Các kiểm thử tự động bổ sung phải kiểm tra UI đúng hai menu/hai nút, snapshot khi xác nhận, phiên còn hợp lệ sau 60 giây nhưng hết hạn ở 10 phút, lỗi quyền/đích đầy/nguồn trống/database đóng phiên, dừng ở lỗi đầu tiên (`failed`, `unknown`, HTTP 429), lỗi tiến độ/audit và bảo toàn kết quả trước lỗi.

## 12. Điều kiện hoàn thành (Definition of Done)

Tính năng đạt yêu cầu khi:

1. Command `/voice move-all` mở bảng điều khiển để chọn 1–25 nguồn và 1 đích trong cùng server.
2. Tất cả người dùng thực hợp lệ từ các nguồn được chuyển khi Discord cho phép.
3. Bot accounts không bị chuyển; Voice Relay và Multi Relay Groups vẫn hoạt động như trước.
4. Có xác nhận an toàn, phân quyền rõ ràng và kết quả thành công/thất bại chính xác.
5. Lỗi và rate limit đều dừng ngay, không retry; hủy, bấm lặp, người đổi channel và restart được xử lý an toàn.
6. Vượt qua toàn bộ AC-01 đến AC-22 trên Discord test server trước khi áp dụng cho server đang sử dụng.

---

## 13. Tham khảo kỹ thuật chính thức

- Discord Developer Docs — Guild Member: https://docs.discord.com/developers/resources/guild#modify-guild-member
- Discord Developer Docs — Application Commands: https://docs.discord.com/developers/interactions/application-commands
- Discord Developer Docs — Message Components (Select Menus): https://docs.discord.com/developers/components/reference

> **Ghi chú:** Đây là đặc tả hành vi/tính năng để phát triển trên hệ thống Discord CrossTalk đã có. Không chứa source code và không yêu cầu viết lại nền tảng Voice Relay.
