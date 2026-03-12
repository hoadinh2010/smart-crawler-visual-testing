# Visual Testing Skill - Hướng dẫn sử dụng

## Giới thiệu

Visual Testing là một Claude Code skill tự động crawl UI và phân tích bằng AI vision. Skill hoạt động như một user thật:

1. **Login** vào app
2. **Quét sidebar menu** — tự phát hiện tất cả menu items (DFS)
3. **Click mọi interactive element** trên từng trang (buttons, tabs, dropdowns, table rows...)
4. **Chụp screenshot** mỗi trạng thái (page load, modal open, tab switch, detail page...)
5. **Phân tích** từng screenshot bằng AI vision
6. **Báo cáo** tổng hợp bugs theo mức độ nghiêm trọng

**Zero config.** Chỉ cần `baseUrl` và login credentials.

### Phát hiện được gì?

- Component bị chồng chéo (overlapping), z-index sai
- Layout bị vỡ, grid bị lệch, column overlap
- Text bị cắt, font không nhất quán, hiển thị "undefined"/"null"/"NaN"
- Spacing (padding/margin) bất thường, element mồ côi (orphaned)
- MUI form controls bị lệch chiều cao, label notch rendering sai
- Content bị overflow ra ngoài container
- Badge/tag màu sắc sai ngữ nghĩa (vd: "Active" badge màu đỏ)
- Raw technical content lộ ra cho user (stack trace, ARN, error code)
- Modal/drawer hiển thị sai (không center, overflow, thiếu backdrop)
- Form fields bên trong modal bị lỗi
- Tab switch không đổi content
- Delete dialog thiếu warning hoặc nút Cancel không rõ

## Cài đặt

Chỉ cần cài Playwright 1 lần:

```bash
npm install -g tsx
npm install -g playwright
npx playwright install chromium
```

**Không cần tạo file config thủ công.** Claude sẽ hỏi bạn mọi thứ khi chạy lần đầu.

## Cách chạy

Trong Claude Code, nói:

```
visual test
```

### Lần đầu chạy — Claude hỏi bạn tất cả

```
Claude: Chưa có config visual test. Mình cần vài thông tin:

  1. URL môi trường test:
     - Local (vd: http://localhost:3000)
     - Staging (vd: https://staging.example.com)

  2. Login credentials:
     - Username: ?
     - Password: ?
     - Login path (mặc định: /login): ?

  3. Viewport (mặc định: 1920x1080) — muốn thay đổi không?
```

Bạn trả lời, ví dụ:

```
local: http://localhost:3000
staging: https://staging.data.langfarm.com
user: admin@admin.com
pass: Admin12345!
viewport mặc định
```

Claude tạo config rồi **tự crawl sidebar menu**:

```
Crawling sidebar menu...

| # | Menu Path              | URL                          | Elements | Actions |
|---|------------------------|------------------------------|----------|---------|
| 1 | Dashboard              | /admin                       | 3 buttons, 2 tabs | 5 clicks |
| 2 | Danh mục > Sản phẩm   | /admin/products/list         | 1 create, 3 filters | 5 clicks |
| 3 | Danh mục > Tồn kho    | /admin/products/inventory    | 2 buttons | 2 clicks |
| 4 | Hoạt động > Đơn hàng  | /admin/orders                | 4 filters, 1 create | 6 clicks |
| ... | ... | ... | ... | ... |

Total: 13 pages, 45 elements
Estimated time: ~8 minutes

Proceed? (y/n)
```

Bạn chọn `y` → Claude chạy execution phase → phân tích screenshots → trả về report.

### Lần chạy tiếp theo

Config đã có sẵn, chạy nhanh:

```
visual test
```

> **Muốn crawl lại?** Xoá file `.claude/visual-test.config.json` rồi chạy lại `visual test`.

## Quy trình tổng quan

```
Lần đầu:
  visual test → Hỏi URL/credentials → Tạo config
    → Discovery Phase (crawl sidebar, scan elements)
    → Hiện test plan → Approve
    → Execution Phase (click elements, screenshot)
    → Analyze screenshots (parallel subagents)
    → Report

Lần sau:
  visual test → Đọc config → Discovery → Approve → Execute → Analyze → Report
```

## Hai phase của crawler

### Phase 1: Discovery

Crawler login → quét sidebar menu → navigate tới từng page → scan interactive elements.

**Sidebar detection** tự động:
- **Standard links**: Tìm `<a>` tags trong `<nav>` sidebar
- **Icon sidebar**: Phát hiện narrow container (<100px) với icon buttons → click → đọc submenu items
- **Custom config**: Override selectors qua config nếu app có sidebar đặc biệt

**Element classification** — crawler phân loại từng element:
| Type | Ví dụ | Hành động |
|------|-------|-----------|
| `navigation` | Menu link, breadcrumb | Navigate |
| `action-open` | "Tạo mới", "Chi tiết" | Click → screenshot modal/drawer |
| `action-danger` | "Xóa", "Delete" | Click → screenshot confirm dialog |
| `action-submit` | "Lưu", "Submit" | Skip (tránh side effects) |
| `tab` | Tab headers | Click → screenshot tab content |
| `table-row` | Table rows | Click first row → screenshot detail |
| `dropdown` | Select, combobox | Click → screenshot open state |
| `external` | External links | Skip |

### Phase 2: Execution

Crawler navigate từng page → click từng element theo test plan → screenshot mỗi state → close modal/drawer → tiếp tục.

**Close escalation**: Close button → Cancel button → Escape key → Force navigate back.

## Config nâng cao

### Sidebar selectors

Nếu app có sidebar đặc biệt, override selectors:

```json
{
  "sidebar": {
    "iconSelector": ".sidebar-icon",
    "submenuContainerSelector": ".submenu-panel",
    "submenuItemSelector": ".submenu-link",
    "submenuTitleSelector": ".submenu-title"
  }
}
```

### Post-login redirect

Nếu app có trang trung gian sau login (chọn tenant, chọn workspace...):

```json
{
  "auth": {
    "postLoginPath": "/admin/products/list",
    "successUrlPattern": "**/admin**"
  }
}
```

### Limits

```json
{
  "limits": {
    "maxPages": 100,
    "maxDuration": 1800000,
    "maxElementsPerPage": 30
  }
}
```

## Phương pháp phân tích (5-pass scan)

AI dùng hệ thống scan có cấu trúc cho **mỗi** screenshot:

| Pass | Tên | Kiểm tra gì |
|------|-----|-------------|
| 1 | Structure Scan | Nhận dạng layout: 1/2/3 cột, sidebar, toolbar, modal, sticky |
| 2 | Boundary Scan | Mọi ranh giới giữa các vùng: overlap, gap, bleed-through |
| 3 | Row-by-Row Scan | Quét từ trên xuống theo strip: title, filters, content, pagination |
| 4 | Element Scan | Từng button, input, badge, icon, text |
| 5 | Interaction State | Modal/drawer, form, tab switch, dropdown, detail page, delete dialog |

## Mức độ nghiêm trọng

| Level | Ý nghĩa | Ví dụ |
|-------|---------|-------|
| **CRITICAL** | Layout vỡ, content bị che/mất, phải fix ngay | Component overlap, data mismatch, raw error lộ, page crash, scroll phá layout |
| **WARNING** | Có vấn đề nhưng vẫn dùng được | Spacing lệch, form control height khác nhau, missing empty state, badge màu sai |
| **INFO** | Gợi ý cải thiện | Whitespace nhỏ, missing hover state, minor a11y |

## Kết quả phân tích

Report cuối cùng:

```
## Visual Test Report — 2026-03-12

### Summary
| Metric | Value |
|--------|-------|
| Pages tested | 13/13 |
| Elements clicked | 38/45 |
| Skipped (by design) | 5 (3 external, 2 submit) |
| Skipped (error) | 2 (timeout after retry) |
| Bugs found | 7 |
| Screenshots taken | 51 |

### CRITICAL (2)
#### 1. Danh mục > Sản phẩm — Detail panel overlaps list table
- **Page:** Danh mục > Sản phẩm (/admin/products/list)
- **Screenshot:** `products-list-page.png`
- **Description:** Detail panel's border starts before the list column ends

#### 2. Hoạt động > Hóa đơn — Raw AWS ARN visible
- **Page:** Hoạt động > Hóa đơn (/admin/invoices)
- **Screenshot:** `invoices-error-modal.png`
- **Trigger:** Clicked "Chi tiết" button
- **Description:** Error message shows raw ARN string

### WARNING (3)
...

### INFO (2)
...

### Execution Log
| # | Menu Path | Status | Duration | Elements | Issues |
|---|-----------|--------|----------|----------|--------|
| 1 | Dashboard | OK | 12s | 5/5 | 0 |
| 2 | Sản phẩm | ISSUES | 18s | 4/5 | 1 |
...
```

## Cấu trúc skill

```
~/.claude/skills/visual-testing/
  SKILL.md              # Orchestrator — điều phối workflow
  crawler-script.ts     # Playwright crawler (login, sidebar scan, element click, screenshot)
  analyze-prompt.md     # Prompt phân tích UI cho subagent (5-pass scan)
  guide.md              # File hướng dẫn này
  package.json          # Playwright dependency
```

## Xử lý lỗi thường gặp

| Lỗi | Cách fix |
|-----|----------|
| `Login timed out` | Start dev server, kiểm tra URL |
| `Login failed` | Kiểm tra username/password |
| `Password change required` | Reset password trong AWS Console |
| `0 menu items found` | Thêm `postLoginPath` vào config |
| `__name is not defined` | Bug đã fix trong crawler-script.ts |
| `Playwright not found` | `npm install -g playwright && npx playwright install chromium` |
| Sidebar không detect được | Thêm `sidebar` selectors vào config |
| Crawler stuck | Check `crawler.log` trong screenshotDir |
| Quá nhiều pages | Giảm `limits.maxPages` trong config |

## Tips

1. **Lần đầu:** Chạy `visual test`, review test plan trước khi approve
2. **Sau khi sửa UI:** Chạy lại để verify fix
3. **Trước release:** Chạy trên staging
4. **Chia sẻ cho team:** Skill nằm trong `~/.claude/skills/visual-testing/` — mỗi người tạo config riêng
5. **Custom sidebar:** Nếu auto-detect không hoạt động, thêm selectors vào config
