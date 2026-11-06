# Phucboo Agents

Bộ AI Agent cá nhân chạy bằng Claude, giao diện "phòng chiếu" sáng/tối, tiếng Việt / English.

Website: **https://dinhtanphuc.github.io/web-profile-phucboo/**

## Các agent

| Nhóm | Agent | Ghi chú |
|---|---|---|
| Sáng tạo nội dung | Prompt Video, Prompt Ảnh, Kịch bản video ngắn | Chỉ cần API key Claude |
| | Higgsfield Studio | Tạo ảnh / video thật, cần kết nối Higgsfield |
| | Dựng video CapCut | Lên timeline, hướng dẫn CapCut, tải file phụ đề .srt |
| | Tải video FB / TikTok | Cần Worker |
| Công việc | QC Test Case, Viết Bug Report, Trợ lý Jira | Đọc / tạo ticket khi có kết nối Jira |
| | Dịch & Viết lại | |
| | IFD Test Case, IFD Tạo ticket, IFD Refine ticket | Nhập riêng từ file `ifd-agents.json` (xem bên dưới) |
| Cá nhân | Học tiếng Anh, Trợ lý chung | |

Nhóm là dropdown: bấm tên nhóm để mở / thu gọn. Bấm ☆ để ghim agent lên đầu.

## Cấu trúc

```
index.html          Khung giao diện
assets/agents.js    Danh sách agent, nhóm, cấu hình chung   ← file bạn sửa nhiều nhất
assets/i18n.js      Chữ giao diện tiếng Việt / tiếng Anh
assets/app.js       Logic: chat, gọi Claude API, kết nối MCP, tải video
assets/style.css    Giao diện
worker/worker.js    Máy chủ Cloudflare: tải video + cầu nối Jira + MCP Higgsfield
```

## Cập nhật website

Repo → **Add file → Upload files** → kéo thả các file/thư mục trên (ghi đè file cũ) → **Commit changes**. Đợi 1–2 phút, Ctrl + F5.

## 1. API key Claude

Mở website → Cài đặt → dán Anthropic API key (https://console.anthropic.com/settings/keys). Key chỉ lưu trong trình duyệt. API tính phí theo lượng dùng, tách biệt với gói Claude Pro/Max; nên đặt spend limit.

## 2. Máy chủ Worker (Cloudflare, miễn phí)

Dùng cho: tải video FB/TikTok, kết nối Jira, kết nối Higgsfield.

1. https://dash.cloudflare.com → **Workers & Pages → Create → Start with Hello World!** → tên `phucboo-video` → **Deploy**.
2. **Edit code** → xoá code mẫu → dán toàn bộ `worker/worker.js` → **Deploy**.
3. Copy địa chỉ dạng `https://phucboo-video.<tên-bạn>.workers.dev`, dán vào `APP_CONFIG.downloaderApi` trong `assets/agents.js` (hoặc vào Cài đặt trên website).
4. Worker → **Settings → Variables and Secrets**, thêm:

| Tên | Loại | Giá trị |
|---|---|---|
| `ALLOWED_ORIGINS` | Text | `https://dinhtanphuc.github.io` |
| `HF_KEY` | Secret | `<Higgsfield key ID>:<Higgsfield key secret>` (tạo tại https://console.higgsfield.ai) |
| `HF_MCP_TOKEN` | Secret | Một chuỗi dài bất kỳ bạn tự đặt, ví dụ 40 ký tự ngẫu nhiên |

Sau khi thêm biến, bấm **Deploy** lại.

## 3. Kết nối Jira / Confluence

1. Tạo API token tại https://id.atlassian.com/manage-profile/security/api-tokens (chọn loại dành cho Rovo MCP, cấp quyền đọc/ghi Jira).
2. Admin Atlassian của công ty phải bật **API token authentication** cho Rovo MCP server. Nếu chưa bật, kết nối sẽ báo lỗi 401/403.
3. Website → Cài đặt → **Kết nối (MCP)** → nhập email Atlassian và token → Lưu.

Agent QC Test Case, Viết Bug Report, Trợ lý Jira và 3 agent IFD sẽ tự dùng Jira. Nút "Jira" phía trên ô nhập để bật/tắt cho từng cuộc trò chuyện. Mọi thao tác ghi (tạo, sửa, chuyển trạng thái) đều được agent cho xem trước và chờ bạn xác nhận.

> Token Jira lưu trong trình duyệt và đi qua Claude API → Worker của bạn → Atlassian. Không dùng trên máy dùng chung.

## 4. Kết nối Higgsfield

1. Cài Worker và 2 biến `HF_KEY`, `HF_MCP_TOKEN` ở bước 2.
2. Website → Cài đặt → Kết nối → Higgsfield → nhập đúng chuỗi `HF_MCP_TOKEN` → Lưu.
3. Chọn agent **Higgsfield Studio**, gõ yêu cầu. Ảnh/video kết quả hiện ngay trong chat (Higgsfield chỉ giữ file 7 ngày, nhớ tải về).

Công cụ: `generate_image` (Grok Image 2.0 hoặc Soul v2), `generate_video` (Cinema Studio 4.0, 4–30 giây), `check_generation`, `generate_custom` (gọi model Higgsfield bất kỳ theo model_id). Video tốn credit theo giây, xem giá trong Higgsfield Console.

## 5. Agent IFD SDLC (nội bộ, không đưa lên GitHub)

File `ifd-agents.json` chứa 3 agent dựa trên bộ skill IFD SDLC (generate-test-cases, create-ticket, refine-ticket). Đây là quy trình nội bộ Infodation, còn repo này công khai, nên **không upload file đó lên repo**. Thay vào đó:

Website → Cài đặt → **Nhập file JSON** → chọn `ifd-agents.json`. Các agent hiện trong nhóm Công việc, chỉ trên trình duyệt đó. Làm lại bước này trên máy khác.

## 6. CapCut

CapCut không có kết nối chính thức cho Claude. Agent "Dựng video CapCut" lên timeline, hướng dẫn từng thao tác và xuất file `.srt` (nút **Tải file .srt** trên khối phụ đề → CapCut: Văn bản → Nhập phụ đề).

Muốn Claude tự tạo bản nháp CapCut: dùng dự án cộng đồng **VectCutAPI** (https://github.com/sun-guannan/VectCutAPI) chạy trên máy tính cùng Claude Desktop hoặc Claude Code. Cách này cần Python, chạy cục bộ, nên không gắn được vào website.

## Thêm agent mới

- Trên website: “＋ Tạo agent”, chọn nhóm và kết nối. Sao lưu: Cài đặt → Xuất file JSON.
- Cố định cho mọi thiết bị: thêm một khối `{ ... }` vào `assets/agents.js` (`group`: `creative` / `work` / `personal`, `mcp`: `["jira"]` hoặc `["higgsfield"]`).

Link nhanh: `?agent=english-tutor`, `?lang=en`.

## Bảo mật

- Không dán API key, token, mật khẩu vào file trong repo.
- Không nhập key trên máy dùng chung. Xoá: Cài đặt → “Xoá toàn bộ dữ liệu”.
- Lỡ lộ key: thu hồi ngay trên trang của dịch vụ (Anthropic Console, Atlassian, Higgsfield Console) và tạo key mới.
