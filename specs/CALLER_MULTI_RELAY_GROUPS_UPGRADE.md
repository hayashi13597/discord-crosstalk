# Shotcaller Bot — Đặc tả nâng cấp Multi Relay Groups

**Trạng thái hiện tại:** Mô hình 3 team / 15 người đã triển khai và hoạt động thành công
**Mục tiêu nâng cấp:** Thêm một nhóm 3 team / 15 người độc lập, để tổng cộng có 2 nhóm, 6 team và 30 người hoạt động đồng thời trên cùng Discord server.

## 1. Bối cảnh và nguyên tắc nâng cấp

Hệ thống hiện có 3 voice channel, mỗi channel là một team gồm 1 leader và 4 member. Leader của mỗi team được nghe ở hai voice channel còn lại; âm thanh member không được truyền sang team khác. Các leader có thể nói đồng thời; hệ thống trộn âm thanh và ngăn relay loop. Leader được quản lý bằng slash command và cấu hình có thể lưu bền vững.

**Yêu cầu quan trọng nhất:** Không thay đổi hoặc làm gián đoạn luồng relay của 3 team đang chạy. Nâng cấp phải theo hướng mở rộng hệ thống hiện hữu, tái sử dụng engine nhận giọng, bộ trộn và cơ chế chống loop đã hoạt động thành công.

## 2. Mô hình đích

| Thành phần           | Trước nâng cấp                   | Sau nâng cấp                                |
| -------------------- | -------------------------------- | ------------------------------------------- |
| Relay Groups         | 1 nhóm ngầm định                 | 2 nhóm độc lập (có thể mở rộng)             |
| Team/voice channel   | 3                                | 6                                           |
| Leader               | 3                                | 6                                           |
| Member               | 12                               | 24                                          |
| Tổng người dùng      | 15                               | 30                                          |
| Discord bot accounts | 3                                | 6 (cùng một Discord server)                 |
| Railway service      | 1                                | Ưu tiên giữ 1, tùy tài nguyên               |
| Lưu cấu hình         | Đã có hoặc theo mô hình hiện tại | Bổ sung cấu trúc group/team, giữ dữ liệu cũ |

### 2.1. Group A — Nhóm hiện tại

- **Team A1:** Voice A1 — 1 leader + 4 member.
- **Team A2:** Voice A2 — 1 leader + 4 member.
- **Team A3:** Voice A3 — 1 leader + 4 member.
- Leader ở A1 được phát tới A2 và A3; tương tự cho A2, A3.
- Người đang ở cùng channel với leader nghe giọng leader trực tiếp qua Discord; **không** phát ngược lại qua bot ở channel nguồn.

### 2.2. Group B — Nhóm bổ sung

- **Team B1:** Voice B1 — 1 leader + 4 member.
- **Team B2:** Voice B2 — 1 leader + 4 member.
- **Team B3:** Voice B3 — 1 leader + 4 member.
- Leader ở B1 được phát tới B2 và B3; tương tự cho B2, B3.

### 2.3. Cách ly âm thanh tuyệt đối giữa group

- Luồng từ Group A **không** được phát đến bất kỳ voice channel nào thuộc Group B, và ngược lại.
- Group A và B có cấu hình leader, trạng thái, hàng đợi âm thanh và mixer riêng.
- Khi một group bị lỗi, group còn lại phải tiếp tục vận hành nếu tài nguyên và kết nối còn đáp ứng.
- Một voice channel chỉ được gán cho **một** group tại cùng thời điểm.

## 3. Nguyên tắc truyền âm thanh

1. Chỉ nhận để relay giọng của **leader đang được gán** cho team tương ứng, khi leader thực sự ở đúng voice channel đó.
2. Member chỉ giao tiếp nội bộ voice channel của họ.
3. Leader của một team được nghe trực tiếp trong channel của team mình, đồng thời được bot chuyển giọng sang **các team khác trong cùng group**.
4. Khi hai hoặc ba leader cùng group nói đồng thời, hệ thống trộn các giọng tại từng channel đích, không áp dụng cơ chế người nói trước được ưu tiên.
5. Âm thanh từ Group A và Group B không bao giờ được trộn chung.
6. Không nhận giọng của chính bot relay hoặc các bot relay khác để phát lại, nhằm chống vòng lặp và echo.
7. Khi xóa hoặc đổi leader, âm thanh của leader cũ phải ngừng được relay ngay sau khi thay đổi có hiệu lực; không yêu cầu restart.

## 4. Chuyển từ cấu hình team cố định sang Relay Groups

### 4.1. Đối tượng quản lý

**Relay Group:** có ID duy nhất, tên hiển thị, trạng thái (active/paused), danh sách team.
**Team:** có ID duy nhất, tham chiếu tới group, voice channel ID, leader User ID (có thể trống), bot account phụ trách và trạng thái kết nối.
**Bot Worker:** một Discord bot account được phân công kết nối với một team/voice channel khi hoạt động.

### 4.2. Ràng buộc dữ liệu

- Tên group không được gây nhầm lẫn trong phạm vi server; hệ thống dùng ID ổn định để tham chiếu.
- Một voice channel không xuất hiện ở hai team/group cùng lúc.
- Một team có tối đa một leader đang hoạt động.
- Không được phân công cùng bot account vào hai voice channel đồng thời **trong cùng Discord server**.
- Nếu chưa có bot account rảnh, không được kích hoạt team mới; phải trả thông báo rõ ràng.
- Khi thao tác thay đổi group/team thất bại, cấu hình đang chạy phải được giữ nguyên hoặc hoàn tác an toàn.

## 5. Slash commands đề xuất

Các command bên dưới là **giao diện yêu cầu** cho bản nâng cấp. Có thể điều chỉnh cú pháp theo hệ thống command hiện tại để tránh phá vỡ tính tương thích.

| Command minh họa                                 | Mục đích                                               |
| ------------------------------------------------ | ------------------------------------------------------ |
| `/group create name:Bravo`                       | Tạo Group B                                            |
| `/group list`                                    | Liệt kê group và số team/trạng thái                    |
| `/group info group:Bravo`                        | Xem cấu hình, leader và kết nối trong group            |
| `/group pause group:Bravo`                       | Tạm ngừng relay của riêng Group B                      |
| `/group resume group:Bravo`                      | Tiếp tục Group B                                       |
| `/group delete group:Bravo`                      | Xóa group sau khi xác nhận, không ảnh hưởng group khác |
| `/team add group:Bravo channel:<voice-channel>`  | Thêm voice channel làm team trong Group B              |
| `/team remove channel:<voice-channel>`           | Gỡ team khỏi group                                     |
| `/team list group:Bravo`                         | Danh sách team thuộc group                             |
| `/leader set channel:<voice-channel> user:@user` | Gán hoặc thay leader team                              |
| `/leader remove channel:<voice-channel>`         | Xóa leader team                                        |
| `/leader list group:Bravo`                       | Xem các leader của Group B                             |
| `/status`                                        | Tổng quan tất cả group và bot                          |

**Phân quyền:** Chỉ quản trị viên hoặc role quản lý được chỉ định mới được tạo/xóa/sửa group, team và leader. Các phản hồi thao tác quản trị nên ở chế độ riêng tư (ephemeral) khi thích hợp. Các thao tác xóa phải có xác nhận để tránh xóa nhầm.

**Tương thích ngược:** Nếu hiện tại command `/leader set team:1 ...` đang hoạt động, cần tiếp tục hỗ trợ command cũ cho Group A hoặc đưa ra quy trình chuyển đổi rõ ràng trước khi thay thế. Không được âm thầm làm sai lệch team số 1/2/3 cũ.

## 6. Tự động gán bot accounts

- Giữ nguyên 3 bot accounts đang phục vụ Group A để giảm rủi ro.
- Thêm 3 Discord bot accounts dành cho Group B và mời vào server với quyền cần thiết để tham gia/phát voice.
- Hệ thống quản lý danh sách bot accounts từ biến môi trường bí mật trên Railway; **không** lưu token trong cơ sở dữ liệu hoặc phản hồi command.
- Một bot account chỉ phục vụ một voice channel tại một thời điểm trong cùng server.
- Khi khởi động, khôi phục đúng ánh xạ bot ↔ team đã lưu, tránh chuyển các bot Group A sang Group B ngoài ý muốn.
- Khi bot mất kết nối, thực hiện reconnect có kiểm soát và chỉ ảnh hưởng team/group tương ứng.

> Mở rộng thêm group trong tương lai cần bổ sung đủ bot accounts cho các voice channel hoạt động đồng thời; “tạo group động” không đồng nghĩa có thể vô hạn số team chỉ với 6 bot accounts.

## 7. Railway và triển khai

**Ưu tiên:** tiếp tục sử dụng **một Railway service** chạy nhiều Discord bot clients và các relay group trong cùng ứng dụng. Việc này tránh tăng số service chỉ vì có thêm group. Có thể tách service nếu quá tải hoặc cần phân tách lỗi cao hơn trong tương lai.

Yêu cầu vận hành:

- Bổ sung bí mật/token cho 3 bot accounts mới bằng Railway Variables; giữ nguyên token cũ.
- Giữ cấu hình/dữ liệu bền vững qua restart và redeploy (database hiện tại, hoặc PostgreSQL/SQLite gắn volume nếu chưa có).
- Không bật chế độ ngủ khi không có HTTP traffic; ứng dụng Discord voice phải chạy liên tục.
- Chỉ chạy **một bản instance đang nhận relay** cho cùng một bộ bot accounts và voice channel để tránh giành kết nối; tránh scale nhiều replicas vô ý.
- Theo dõi RAM, CPU và network khi hoạt động cả 6 channel, nhất là khi 6 leader nói đồng thời.
- Không đưa token, thông tin nhạy cảm hoặc audio thô vào log.

## 8. Migrate dữ liệu và tương thích ngược

1. Sao lưu cấu hình/database hiện tại trước nâng cấp.
2. Tạo Group A mặc định và đưa **nguyên vẹn** ba team cũ (voice channel ID, leader ID, bot ID) vào Group A.
3. Xác nhận Group A vẫn relay bình thường **trước khi** kích hoạt Group B.
4. Tạo Group B, thêm ba voice channel mới, gán ba bot accounts mới.
5. Dùng slash commands đặt leader B1/B2/B3; không hardcode leader ID trong Railway Variables.
6. Khởi động Group B và kiểm tra tính độc lập giữa hai group.
7. Nếu có sự cố, tắt Group B và khôi phục hoạt động Group A theo bản cấu hình trước đó.

Migration phải có phương án rollback và không ghi đè bảng dữ liệu leader cũ trước khi kiểm tra thành công.

## 9. Giám sát, lỗi và trải nghiệm quản trị

- `/status` cho biết group nào active/paused, số team, trạng thái kết nối mỗi bot và leader được gán.
- Báo lỗi cụ thể khi thiếu bot account, trùng voice channel, thiếu quyền voice, leader không ở đúng channel, hoặc database không ghi được cấu hình.
- Khi Group B lỗi, cảnh báo nhưng không tự động dừng Group A.
- Khi đổi leader, thay đổi áp dụng ngay, không cần redeploy Railway.
- Khi restart Railway, khôi phục tất cả group/team/leader và tự kết nối lại theo cấu hình đã lưu.
- Không cần tính năng ghi âm hoặc lưu nội dung hội thoại cho yêu cầu này.

## 10. Tiêu chí nghiệm thu

| ID    | Kịch bản                                 | Kết quả bắt buộc                                     |
| ----- | ---------------------------------------- | ---------------------------------------------------- |
| AC-01 | Sau migration, chỉ bật Group A           | Ba team cũ hoạt động y như trước                     |
| AC-02 | Leader A1 nói                            | Chỉ A2, A3 nhận relay; B1–B3 không nghe              |
| AC-03 | Leader B2 nói                            | Chỉ B1, B3 nhận relay; A1–A3 không nghe              |
| AC-04 | Member A1 hoặc B2 nói                    | Không được relay sang team khác                      |
| AC-05 | Hai leader Group A nói đồng thời         | Team còn lại trong A nghe được cả hai; B không nghe  |
| AC-06 | Ba leader Group B nói đồng thời          | Mixer B hoạt động; Group A không bị ảnh hưởng        |
| AC-07 | A và B cùng đang relay                   | Hai nhóm hoạt động song song, không rò rỉ audio      |
| AC-08 | `/leader set` hoặc `/leader remove` ở B  | Có hiệu lực ngay và không đổi leader của A           |
| AC-09 | Tạm dừng Group B                         | Group A tiếp tục hoạt động bình thường               |
| AC-10 | Restart/redeploy Railway                 | Khôi phục group, team, leader, ánh xạ bot đã lưu     |
| AC-11 | Gán voice channel đã dùng vào group khác | Từ chối và báo lỗi dễ hiểu                           |
| AC-12 | Không còn bot account trống              | Từ chối kích hoạt team mới, không cướp bot đang chạy |
| AC-13 | Bot của Group B mất kết nối              | Khôi phục hoặc báo lỗi riêng; Group A không ngừng    |
| AC-14 | Leader rời voice channel                 | Dừng relay giọng leader đó; các relay khác không đổi |
| AC-15 | Bot nghe chính giọng bot phát            | Không phát lại, không tạo vòng lặp/echo              |

## 11. Phạm vi và thứ tự ưu tiên

### Bắt buộc trong bản nâng cấp

- Hai Relay Groups hoạt động độc lập trong cùng Discord server.
- Tổng cộng 6 team, mỗi team 1 leader, 4 member theo kịch bản hiện tại.
- Trộn âm thanh leader đồng thời **bên trong từng group**, chống loop.
- Quản lý group/team/leader bằng slash commands và lưu cấu hình bền vững.
- Bổ sung 3 bot accounts, tiếp tục deploy qua Railway.
- Migration an toàn từ mô hình Group A đang hoạt động, có rollback.

### Có thể làm sau

- Dashboard web quản trị.
- Tự chọn cấu hình số team khác 3/team group với giao diện nâng cao.
- Điều khiển âm lượng theo group/leader.
- Metrics độ trễ và cảnh báo tự động.
- Điều phối phân tán qua nhiều Railway services.

## 12. Kết quả mong đợi

Nâng cấp thành công khi **Group A (3 team cũ) vẫn giữ nguyên hành vi đang hoạt động**, Group B (3 team mới) có thể hoạt động đồng thời, tất cả leader chỉ được relay trong group của mình, thành viên bình thường không bị relay, quản trị viên cấu hình qua Discord commands, và hệ thống có thể khôi phục sau khi Railway restart mà không phải cấu hình lại.
