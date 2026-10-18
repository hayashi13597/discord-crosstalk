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
- Chọn **từ 1 đến nhiều channel nguồn, không giới hạn cứng 3 channel**, qua giao diện tương tác Discord và **1 channel đích**. Khi nhiều hơn 25 nguồn, hỗ trợ tích lũy theo nhiều lượt chọn.
- Di chuyển tất cả **người dùng thực** đang có mặt ở các channel nguồn tại thời điểm chụp danh sách.
- Mặc định **không di chuyển bot accounts**, bao gồm cả các bot Discord CrossTalk; không làm thay đổi kết nối bot phục vụ Voice Relay.
- Người có quyền có thể di chuyển cả leader lẫn member, không phân biệt Relay Group.
- Thao tác chạy theo từng người; tổng kết thành công/thất bại, không tuyên bố thành công toàn bộ nếu có lỗi.
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

| Thành phần                            | Mô tả                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| Chọn nguồn                            | Multi-select các voice channel, 1–25 lựa chọn mỗi lượt theo giới hạn Discord |
| **Thêm nguồn**                        | Lưu lựa chọn hiện tại vào danh sách nguồn tích lũy của phiên                 |
| **Danh sách đã chọn**                 | Hiển thị tổng số và danh sách nguồn (phân trang/tóm tắt nếu dài)             |
| **Xóa nguồn** / **Xóa tất cả**        | Chỉnh sửa danh sách đã tích lũy trước khi chạy                               |
| Chọn đích                             | Single-select đúng 1 voice channel làm đích                                  |
| **Xem trước**                         | Kiểm tra quyền và tính số người dự kiến chuyển                               |
| **Xác nhận** / **Quay lại** / **Hủy** | Thực thi, thay đổi lựa chọn hoặc bỏ tác vụ                                   |

**Không có giới hạn cố định về tổng số nguồn theo nghiệp vụ.** Tuy nhiên, một menu không thể chọn vô hạn: mỗi lượt tối đa 25 lựa chọn và người dùng lặp lại bước **Thêm nguồn** để tích lũy hơn 25 nguồn. Quy mô thực tế vẫn chịu giới hạn số channel trong server, thời hạn phiên, sức chứa đích và năng lực Discord API. Không được gắn nhãn “không giới hạn” như cam kết không có bất kỳ giới hạn kỹ thuật nào.

**Ví dụ:** chạy `/voice move-all`, chọn `#Voice-A`, `#Voice-B`, `#Voice-C`, bấm **Thêm nguồn**, chọn `#Voice-D` làm đích, xem trước rồi xác nhận. Toàn bộ người đủ điều kiện đang ở ba nguồn sẽ được chuyển sang D.

**Tùy chọn phát triển sau:** `/voice move-group group:Alpha to:#Lobby` tự chọn các channel trong một Relay Group; không thuộc phạm vi MVP.

## 4. Luồng sử dụng

1. Người có quyền gọi `/voice move-all`; bot kiểm tra quyền ban đầu và mở phiên riêng tư.
2. Bot hiển thị Channel Select lọc **Guild Voice**; người dùng tích chọn 1–25 nguồn/lượt, bấm **Thêm nguồn**. Có thể lặp lại nhiều lượt và bổ sung hoặc xóa nguồn; lưu theo channel ID và tự loại trùng lặp.
3. Người dùng chọn chính xác 1 channel đích qua Channel Select riêng. Nếu đích đang nằm trong tập nguồn, bot yêu cầu sửa lựa chọn trước khi tiếp tục (không tự chuyển người từ đích đi nơi khác).
4. Người dùng bấm **Xem trước**; bot kiểm tra loại channel, quyền và tình trạng đích, chụp snapshot thành viên từ tất cả nguồn đã chọn; lọc mọi bot account và người trùng ID.
5. Bot hiển thị preview riêng tư gồm danh sách nguồn/đích, số người mỗi nguồn, tổng đủ điều kiện, số bot bị bỏ qua và cảnh báo. Có nút **Xác nhận**, **Quay lại**, **Hủy**.
6. Khi xác nhận, bot kiểm tra lại quyền và vị trí hiện tại của từng thành viên, tạo đúng một job; xử lý theo hàng đợi và tuân thủ rate limit Discord.
7. Bot thông báo tiến trình phù hợp và trả tổng kết thành công/bỏ qua/thất bại, đồng thời lưu audit log. Nếu hủy hoặc phiên hết hạn, không di chuyển ai.

**Quy ước snapshot:** chỉ người có mặt trong các nguồn tại lúc preview được đưa vào job. Người mới vào sau snapshot không được tự thêm; người đã rời nguồn trước lượt xử lý được bỏ qua. Nếu preview đã cũ hoặc người dùng sửa danh sách, phải chụp snapshot lại trước khi xác nhận.

**Thời hạn phiên:** đề xuất 10 phút khi đang chọn nhiều nguồn; bước xác nhận có thể hết hạn nhanh hơn (ví dụ 60 giây). Khi hết hạn, yêu cầu mở phiên mới; không tự thực thi.

## 5. Quy tắc nghiệp vụ

1. Có tối thiểu 1 channel nguồn, **không có trần cố định 3 nguồn**. Mỗi lượt Channel Select chọn tối đa 25 nguồn; phiên tích lũy được nhiều lượt.
2. Loại trùng channel nguồn theo ID khi tích lũy; channel đích không được nằm trong tập nguồn. Yêu cầu sửa lựa chọn và không thực hiện nếu vi phạm.
3. Tính năng chỉ di chuyển thành viên **đang kết nối voice**, không mời/kéo người offline vào voice.
4. Mặc định bỏ qua mọi bot account (không chỉ 6 bot Discord CrossTalk), bảo đảm hệ thống relay giữ nguyên vị trí. Không cung cấp tùy chọn di chuyển bot trong MVP.
5. Không thay đổi cấu hình leader, các Relay Group, thông số audio, quyền channel hoặc role của user.
6. Cho phép chọn nguồn từ nhiều Relay Group khác nhau, nhưng việc di chuyển không gộp Relay Groups về mặt cấu hình. Sau khi di chuyển, leader không còn ở channel gốc thì relay tương ứng có thể tạm ngừng nhận tiếng leader theo quy tắc đã có.
7. Không di chuyển một user hai lần trong cùng một tác vụ.
8. Không tự di chuyển user trở lại phòng cũ khi có một phần tác vụ thất bại; báo cáo trạng thái từng user và cho phép quản trị viên quyết định xử lý tiếp.
9. Mỗi guild chỉ được có **một tác vụ Mass Voice Move đang thực thi** tại một thời điểm để tránh đua trạng thái; lượt thứ hai được từ chối với thông báo rõ ràng.
10. Không đặt trần 3 channel; có thể cấu hình **ngưỡng cảnh báo/xác nhận bổ sung theo số người** (ví dụ trên 100 người) để an toàn, không âm thầm cắt danh sách. Khối lượng lớn được xử lý theo hàng đợi và rate limit.

## 6. Phân quyền và bảo mật

- Người gọi phải có quyền Discord **Move Members** trong guild và thuộc nhóm vai trò quản trị được cho phép sử dụng command (quy tắc mặc định: `Manage Guild` hoặc `Administrator`; có thể mở rộng allowlist role sau).
- Bot account xử lý command cần quyền **Move Members** và quyền **Connect** với channel đích, đồng thời phải tuân thủ các kiểm tra quyền liên quan của Discord.
- Kiểm tra quyền ở cả bước preview và ngay trước khi bắt đầu thực thi; không tin vào trạng thái đã kiểm tra trước đó.
- Kết quả preview, xác nhận và kết quả chi tiết ưu tiên hiển thị **ephemeral** để tránh spam text channel và lộ danh sách người dùng không cần thiết.
- Chỉ người gọi được thao tác với phiên. Phiên chọn nguồn có thời hạn đề xuất **10 phút**; màn xác nhận hết hạn sau **60 giây** nếu không có hành động, và không được tự chuyển ai.
- Chặn hành động ngoài guild hoặc yêu cầu không hợp lệ; không cần quyền đọc nội dung tin nhắn.

**Lưu ý Discord API:** Di chuyển user được thực hiện qua thao tác cập nhật `channel_id` của guild member; API yêu cầu quyền `MOVE_MEMBERS` và `CONNECT` đối với kênh đích. Discord cũng áp dụng rate limit, vì vậy không đảm bảo mọi người được chuyển cùng một thời điểm tuyệt đối.

## 7. Xử lý giới hạn và lỗi

| Tình huống                                            | Hành vi mong muốn                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Channel nguồn trống                                   | Không lỗi; hiển thị 0 người. Nếu tất cả nguồn trống thì không mở bước xác nhận                         |
| Trùng channel nguồn hoặc nguồn = đích                 | Tự loại trùng nguồn; nếu đích nằm trong tập nguồn thì yêu cầu sửa trước khi chạy                       |
| Bot hoặc người gọi thiếu quyền                        | Không chạy; chỉ rõ quyền còn thiếu                                                                     |
| Đích đầy/giới hạn người tham gia hoặc bị chặn Connect | Không cố vượt giới hạn; ghi nhận thất bại và lý do                                                     |
| User tự rời/chuyển voice khi đang chạy                | Bỏ qua nếu không còn trong nguồn được chọn; không kéo từ channel khác                                  |
| User bị Discord từ chối di chuyển                     | Ghi thất bại riêng cho user, vẫn tiếp tục xử lý người còn lại                                          |
| Discord rate limit (HTTP 429)                         | Tôn trọng hướng dẫn retry của Discord và dùng hàng đợi, không gửi yêu cầu dồn dập                      |
| Một số người đã chuyển thành công trước khi lỗi       | Không rollback tự động; báo kết quả một phần                                                           |
| Tác vụ bị chạy trùng                                  | Từ chối tác vụ mới khi tác vụ cũ đang thực thi                                                         |
| Chọn trên 25 nguồn                                    | Cho phép thêm theo nhiều lượt; hiển thị tổng đã chọn, không mất lựa chọn cũ                            |
| Phiên chọn nguồn hết hạn hoặc channel bị xóa          | Yêu cầu mở lại phiên hoặc sửa lựa chọn; không tự thực thi                                              |
| Railway restart giữa tác vụ                           | Không chạy lại cả tác vụ một cách mù quáng; ghi trạng thái bị gián đoạn và đối soát trước khi chạy lại |

**Giới hạn đích:** kiểm tra giới hạn người dùng và quyền Connect trước khi chuyển, đồng thời xử lý trường hợp Discord từ chối ở thời điểm thực thi do trạng thái thay đổi. Không cam kết có thể ép toàn bộ người vào channel đã đầy.

## 8. Tương thích Discord CrossTalk V2 / Multi Relay Groups

- Feature này nằm trong **module quản trị voice**, tách biệt với voice receiver, mixer và relay router.
- Có thể dùng nguồn là bất kỳ voice channel hợp lệ trong server, không cần thuộc Relay Group.
- Nếu chọn các channel đang có Bot 1–6, bot chỉ chuyển người dùng thực; các bot tiếp tục ở lại phòng cũ.
- Nếu leader bị chuyển khỏi voice channel đã gán, hệ thống relay phải dừng phát tiếng người đó từ team cũ theo logic sẵn có; khi leader quay lại đúng channel, relay hoạt động lại.
- Không sửa hoặc xóa mapping group/team/leader trong database do tác vụ di chuyển.
- Railway vẫn dùng một service hiện tại; không yêu cầu tạo thêm bot account hay service riêng cho tính năng này.
- Có thể dùng **một bot quản trị** (ví dụ bot account chính đã được chọn trước) để đăng ký và tiếp nhận command nhằm tránh 3–6 bot cùng hiện slash command giống nhau.

## 9. Báo cáo và audit log

Sau khi hoàn tất, bot hiển thị:

- Command và người thực hiện (ID), guild, thời điểm.
- Các channel nguồn, channel đích.
- Tổng số thành viên được chọn.
- Số **đã chuyển**, **bỏ qua**, **thất bại**.
- Nguyên nhân lỗi theo nhóm (không đủ quyền, user rời nguồn, channel đầy, Discord từ chối, v.v.).
- Trạng thái: `Completed`, `Partially Completed`, `Cancelled`, `Failed` hoặc `Interrupted`.

Audit log nên lưu trong nơi lưu trữ bền vững đang dùng cho Discord CrossTalk, không chỉ trong bộ nhớ process; đặt thời gian lưu giữ phù hợp và tránh ghi token hay nội dung hội thoại.

## 10. Yêu cầu phi chức năng

- **Tính chính xác:** chỉ di chuyển đúng user nằm trong snapshot từ các nguồn đã chọn và vẫn ở nguồn khi xử lý.
- **An toàn:** không đụng bot accounts hoặc cấu hình Relay Group.
- **Khả năng phục hồi:** xử lý lỗi riêng lẻ; một user thất bại không làm mất kết quả các user khác.
- **Hiệu năng:** xử lý có hàng đợi, không chặn Voice Relay realtime trong cùng process.
- **Trải nghiệm:** phản hồi command nhanh bằng cơ chế deferred interaction nếu cần; dùng menu chọn nguồn/đích trực quan, phân trang danh sách khi dài; luôn có thông tin tiến độ/kết quả.
- **Idempotency:** mỗi thao tác xác nhận chỉ khởi tạo tối đa một tác vụ; tránh xử lý nhiều lần khi nhấn nút liên tiếp.

## 11. Kịch bản kiểm thử / tiêu chí nghiệm thu

| ID    | Kịch bản                                         | Kết quả mong đợi                                                                 |
| ----- | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| AC-01 | A có 5, B có 4, C có 6 user; D trống             | 15 user thật được chuyển sang D, 0 ở A/B/C nếu không ai rời giữa chừng           |
| AC-02 | A/B/C có bot Discord CrossTalk                   | Chỉ người thật chuyển, bot vẫn ở channel cũ                                      |
| AC-03 | A/B/C có leader và member                        | Cả leader/member đều được chuyển, không sửa leader assignment                    |
| AC-04 | A và B thuộc Group A; C thuộc Group B            | Chuyển được người ở cả 3 nguồn, không gộp cấu hình group                         |
| AC-05 | Người không có quyền gọi command                 | Bị từ chối, không user nào di chuyển                                             |
| AC-06 | Chọn trùng nguồn hoặc nguồn = đích               | Báo lỗi, không thực thi                                                          |
| AC-07 | Một nguồn trống                                  | Các nguồn còn lại vẫn được xử lý đúng                                            |
| AC-08 | User rời nguồn sau preview                       | User đó được bỏ qua, không kéo từ chỗ mới                                        |
| AC-09 | Đích không đủ chỗ hoặc thiếu quyền               | Báo rõ thất bại; không tuyên bố hoàn tất 100%                                    |
| AC-10 | Discord API trả lỗi cho 1 user                   | Những user còn lại vẫn được xử lý, báo lỗi riêng                                 |
| AC-11 | Người dùng nhấn nút xác nhận 2 lần               | Không tạo hai tác vụ                                                             |
| AC-12 | Tác vụ thứ hai chạy khi tác vụ đầu chưa xong     | Bị chặn rõ ràng                                                                  |
| AC-13 | Hủy hoặc hết hạn xác nhận                        | Không chuyển ai                                                                  |
| AC-14 | Sau khi chuyển leader ra khỏi channel team       | Relay không lấy tiếng leader đó từ channel mới một cách ngoài ý muốn             |
| AC-15 | Railway restart và khởi chạy lại                 | Không tự động di chuyển lại hàng loạt người                                      |
| AC-16 | Chuyển xong và kiểm tra audit                    | Có bản ghi đầy đủ tổng kết và kết quả                                            |
| AC-17 | Chọn 4–25 nguồn qua menu                         | Mọi nguồn được lưu và xử lý, không bị giới hạn 3                                 |
| AC-18 | Chọn hơn 25 nguồn qua ít nhất 2 lượt             | Tích lũy đầy đủ, không mất nguồn hoặc nhân đôi                                   |
| AC-19 | Xóa một nguồn, xóa tất cả và quay lại sửa        | Danh sách/preview cập nhật chính xác; không chuyển nguồn đã xóa                  |
| AC-20 | Phiên hết hạn giữa bước chọn hoặc trước xác nhận | Không thành viên nào bị chuyển                                                   |
| AC-21 | Chọn đích cũng nằm trong nguồn                   | Bắt buộc sửa danh sách trước khi chạy                                            |
| AC-22 | Hai group relay đang hoạt động song song         | Chỉ thay đổi vị trí người đã chọn, không phá cấu hình/voice relay của group khác |

## 12. Điều kiện hoàn thành (Definition of Done)

Tính năng đạt yêu cầu khi:

1. Command `/voice move-all` mở bảng điều khiển để chọn từ 1 đến nhiều nguồn (bao gồm trên 25 nguồn qua nhiều lượt) và 1 đích trong cùng server.
2. Tất cả người dùng thực hợp lệ từ các nguồn được chuyển khi Discord cho phép.
3. Bot accounts không bị chuyển; Voice Relay và Multi Relay Groups vẫn hoạt động như trước.
4. Có xác nhận an toàn, phân quyền rõ ràng và kết quả thành công/thất bại chính xác.
5. Các trường hợp lỗi, rate limit, hủy, bấm lặp, người đổi channel và restart đều được xử lý an toàn.
6. Vượt qua toàn bộ AC-01 đến AC-22 trên Discord test server trước khi áp dụng cho server đang sử dụng.

---

## 13. Tham khảo kỹ thuật chính thức

- Discord Developer Docs — Guild Member: https://docs.discord.com/developers/resources/guild#modify-guild-member
- Discord Developer Docs — Application Commands: https://docs.discord.com/developers/interactions/application-commands
- Discord Developer Docs — Message Components (Select Menus): https://docs.discord.com/developers/components/reference

> **Ghi chú:** Đây là đặc tả hành vi/tính năng để phát triển trên hệ thống Discord CrossTalk đã có. Không chứa source code và không yêu cầu viết lại nền tảng Voice Relay.
