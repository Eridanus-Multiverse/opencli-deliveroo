# opencli-deliveroo

Order from [Deliveroo](https://deliveroo.co.uk) (UK) from your terminal, through your own logged-in Chrome.

This is a user adapter for [opencli](https://github.com/jackwener/opencli). It lists restaurants near your saved address, reads menus, adds and removes basket items, and checks out. Paying needs a one-time confirm code from a fresh preview, so one confirmation is exactly one order.

- Not affiliated with, endorsed by or supported by Deliveroo.
- Automating the Deliveroo website may violate Deliveroo's terms of service. Use at your own risk; your account may be limited or closed.
- Built on [opencli](https://github.com/jackwener/opencli) by jackwener (Apache-2.0).

中文说明在最后：[中文](#中文)。

## Quick start (no programming needed)

You type commands into a terminal: **Terminal** on macOS, **PowerShell** on Windows, any terminal on Linux.

1. **Install Node.js 20 or newer.** Download the LTS version from <https://nodejs.org> and install it. Check it in a new terminal:
   ```
   node --version
   ```
2. **Install opencli** (official instructions: <https://github.com/jackwener/opencli#readme>):
   ```
   npm install -g @jackwener/opencli
   ```
   On macOS and Windows the opencli README also offers a desktop app (OpenCLIApp, <https://opencli.info/download>) that installs the `opencli` command for you.
3. **Add the OpenCLI extension to Chrome.** Install **OpenCLI** from the [Chrome Web Store](https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk) and make sure it is enabled in `chrome://extensions`.
4. **Log in to Deliveroo in that same Chrome.** Open <https://deliveroo.co.uk>, log in, and make sure you have at least one saved delivery address and a saved payment method. This tool never logs in for you.
5. **Install this adapter** (one command):
   ```
   npx github:Eridanus-Multiverse/opencli-deliveroo
   ```
   It copies the adapter into opencli's adapter folder and runs a check. Run it again any time to update.
6. **Check everything** (read-only, safe to run any time):
   ```
   opencli deliveroo doctor
   ```
   Every line should say `ok` or `connected`. If not, the `next` column says exactly what to do.
7. **Try it:**
   ```
   opencli deliveroo restaurants pizza
   ```
8. **Order safely:** add dishes, then preview, then confirm with the code the preview printed.
   ```
   opencli deliveroo add <menu URL from step 7> "Margherita"
   opencli deliveroo checkout
   opencli deliveroo checkout --confirm 1a2b3c4d
   ```
   The preview clicks nothing that changes your account. It prints the full order and an 8-character code. The code works once, for 10 minutes, and only if the basket and total still match. A new preview replaces the old code.

Platform notes:

- **Windows PowerShell** may refuse to run `npm` or `npx` with "running scripts is disabled on this system". Use `npm.cmd` / `npx.cmd` instead, or run the same commands in Command Prompt.
- If `npx github:...` complains about git, install Git from <https://git-scm.com> and retry.
- Environment variables (see [Settings](#settings)): macOS/Linux `export DELIVEROO_MAX_TOTAL=40`; PowerShell `$env:DELIVEROO_MAX_TOTAL="40"`.

## Requirements

- Node.js 20+ and opencli 1.8.7+ (`npm install -g @jackwener/opencli`).
- The OpenCLI Browser Bridge extension in Chrome or Chromium, connected (`opencli doctor` checks it).
- A logged-in Deliveroo session in that Chrome, with a saved address and payment method.

## Install

One command, idempotent:

```
npx github:Eridanus-Multiverse/opencli-deliveroo           # install or update, then check
npx github:Eridanus-Multiverse/opencli-deliveroo --force   # replace a different deliveroo adapter (kept as a backup)
npx github:Eridanus-Multiverse/opencli-deliveroo doctor    # check only
```

opencli loads user adapters from `~/.opencli/clis/<site>/` (`%USERPROFILE%\.opencli\clis\` on Windows). The installer copies the adapter files to `~/.opencli/clis/deliveroo/`. There are no install hooks; nothing runs unless you run it.

Manual install, if you prefer:

```
git clone https://github.com/Eridanus-Multiverse/opencli-deliveroo ~/.opencli/clis/deliveroo
```

Uninstall: delete `~/.opencli/clis/deliveroo`.

## Commands

| Command | What it does |
|---|---|
| `opencli deliveroo doctor` | Read-only check: opencli version, Chrome extension, Deliveroo login. |
| `opencli deliveroo restaurants [keyword] [--address <postcode>] [--limit 15]` | Restaurants delivering to a saved address (default: most recent). |
| `opencli deliveroo menu <restaurant> [--q <word>] [--limit 40]` | A restaurant's dishes, prices and item ids. |
| `opencli deliveroo basket [--restaurant <restaurant>]` | Current basket (read-only). |
| `opencli deliveroo add <restaurant> "<dish>" [--qty 1] [--option "A \| B"] [--dry-run]` | Add one dish. |
| `opencli deliveroo remove "<dish>" [--qty N] [--restaurant <restaurant>] [--dry-run]` | Remove a basket line, or reduce it by N. |
| `opencli deliveroo checkout [--restaurant <restaurant>]` | Preview the order and print a one-time confirm code. |
| `opencli deliveroo checkout --confirm <code> [--dry-run]` | Place exactly one order. `--dry-run` runs every check and stops before Pay now. |

`<restaurant>` is a menu URL from `restaurants` (for example `https://deliveroo.co.uk/menu/london/<area>/<restaurant>`), a `/menu/...` path, or a bare slug (resolved under `DELIVEROO_AREA`). All commands accept opencli's `-f json|yaml|md|csv`.

Examples:

```
opencli deliveroo restaurants ramen --limit 5
opencli deliveroo menu https://deliveroo.co.uk/menu/london/<area>/<restaurant> --q noodles
opencli deliveroo add https://deliveroo.co.uk/menu/london/<area>/<restaurant> "Chicken Ramen" --option "Large" --dry-run
opencli deliveroo add https://deliveroo.co.uk/menu/london/<area>/<restaurant> "Chicken Ramen" --option "Large"
opencli deliveroo basket
opencli deliveroo remove "Chicken Ramen" --qty 1
opencli deliveroo checkout
opencli deliveroo checkout --confirm 1a2b3c4d --dry-run
opencli deliveroo checkout --confirm 1a2b3c4d
```

`add` stops and lists candidates when the dish name is ambiguous, and lists the choices when a required option is missing. It never picks for you.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `DELIVEROO_MAX_TOTAL` | unset (no cap) | Optional spending cap in pounds, e.g. `40`. `--confirm` refuses any order above it. A value that is set but unreadable also refuses. |
| `DELIVEROO_AREA` | `london/soho` | The `city/area` part of a Deliveroo restaurants URL. Used as the warm-up page and for bare slugs. Set it to the one in your own browser's address bar when you browse restaurants. |

## Safety design

Paying is irreversible, and a saved payment method can be a one-click charge. So:

- **Preview by default.** `checkout` without `--confirm` only reads. It clicks nothing that changes your account.
- **No code, no payment.** `--confirm` needs the code from the latest preview, less than 10 minutes old. The code is stored with the preview snapshot in `~/.opencli/state/deliveroo-checkout.json` (owner-only permissions). A new preview replaces it.
- **One code, one order.** The code is consumed (an atomic file rename) right before the single payment keypress. Two concurrent `--confirm` runs cannot both pay.
- **The order must still match.** Right before paying, the page is read again and must show the same shop, items, quantities, options and item prices (basket fingerprint), a total within 50p of the preview, the same payment method, the same street-level address, zero tip and donation, and a total under `DELIVEROO_MAX_TOTAL` if set. Every amount is reconciled to the penny: items must add up to the subtotal, subtotal plus fees to the total, and the total must equal the Pay now button. Any unknown fee line stops.
- **Never retried.** Pay now is pressed once. If no order page appears, the tool says so and stops: an order may exist, and pressing again could charge twice. Check your orders on Deliveroo.
- **Stops on login, 3DS, captcha.** A login page, PayPal sign-in, 3D Secure or one-time-code prompt, or a bot wall stops immediately and hands back to you. Login is never automated.
- **Privacy.** Full addresses, phone numbers and card details stay in the page. Output shows a street name and a masked postcode (`Example Road · ZZ1**`). Printed URLs keep only the `q` search parameter; geohash, coordinates and tracking parameters are removed. No screenshots or receipts are saved.
- **Limits.** The confirm code is a human-in-the-loop speed bump, not authentication: any program running as your user can read the state file. Earlier versions only ever allowed a saved PayPal account, so other payment methods are untested; if the site asks for a CVV, 3DS or a login, the tool stops rather than pays.

## Pitfalls we hit (so you don't have to)

Each one: symptom / why / what the code does now.

1. **Stale page state.**
   Symptom: restaurants, addresses or basket read as empty although the page showed them.
   Why: `window.__NEXT_DATA__` is the server-rendered snapshot; it is not updated by client-side changes.
   Now: read the live React/Redux store found through the React fiber tree, with a node limit.
2. **Duplicate navigation and borrowed tabs.**
   Symptom: "Navigation rejected" when two commands ran back to back on the same tab.
   Why: navigating a tab to the URL it is already on is refused by the extension.
   Now: read-only commands open their own tab, read, and close only that tab, on success or error. Menu navigation reuses whichever Deliveroo page is open and moves with the site's client router.
3. **Cloudflare on direct menu loads.**
   Symptom: opening a `/menu/...` URL directly (or fetching restaurant pages separately) hit "Just a moment" / "Performing security verification".
   Why: a fresh document request for a menu page gets challenged; an already-loaded restaurants listing does not.
   Now: land on a restaurants page, then go to the menu with Next's router; the challenge text is detected and stops the command instead of being mistaken for an empty page.
4. **Basket items are not in the state.**
   Symptom: the basket looked empty in the state while the sidebar showed items.
   Why: the live state only holds a basket shadow (item count and shop link); lines live in the menu page sidebar.
   Now: get the shop link from the shadow, open that menu, read the sidebar's `Quantity N, name, £x` labels. "Unreadable" is never reported as "empty".
5. **The wrong "Add" button.**
   Symptom: a topping got added instead of the dish.
   Why: topping rows inside the item dialog are also labelled "Add", and the first match is one of them.
   Now: click the footer button that says "to basket"/"to order", else the last "Add".
6. **Assuming an add worked.**
   Symptom: an add was reported as done when it was not, or reported missing when it was there under a longer name.
   Why: the line already existed before the click, and sidebar names carry the chosen option ("Burger, Well Done").
   Now: success means the quantity of rows starting with the dish name rose by exactly the requested amount; otherwise "unconfirmed, don't add again".
7. **Options clicked too fast.**
   Symptom: only the last of several `--option` choices stuck.
   Why: choosing a meal deal re-renders the dialog and adds new required groups; earlier row elements are replaced.
   Now: click one option, wait, look again for the next.
8. **"Go to checkout" that does not go.**
   Symptom: a JS click left the URL on the menu; then an upsell dialog blocked the way.
   Why: the click does not always navigate, and "Fancy anything else?" has its own Go to checkout button.
   Now: focus plus a native Enter, then press only the dialog's Go to checkout, never its upsell rows.
9. **A strict button regex.**
   Symptom: checkout navigation failed on a discounted basket.
   Why: the button read "Go to checkout £21.40£19.90 incl. fees", which a stricter pattern rejected.
   Now: match "Go to checkout" anywhere in the button text (navigation is harmless to repeat).
10. **Synthetic Enter that does nothing.**
    Symptom: Enter was "sent" but the button never activated.
    Why: a key event with keyCode 0 and no carriage return does not activate HTML buttons, and a generic fallback could repeat an uncertain action.
    Now: one CDP keyDown/keyUp with keyCode 13 and `\r`; no fallback, no retry.
11. **Pay now is not there yet.**
    Symptom: the checkout showed "Continue" and no Pay now button.
    Why: the payment button renders only after the checkout sections have been scrolled into view.
    Now: scroll each section into view (guarding before every step, no clicks) until Pay now is visible and enabled.
12. **Struck-through prices.**
    Symptom: discounted rows read as two prices ("£5.00£4.00") and the order was rejected.
    Why: the original price is shown with a strike-through next to the current one.
    Now: struck prices that are actually displayed are dropped; anything still ambiguous stops.
13. **Unknown fee lines.**
    Symptom: a new fee (such as a bag charge) appeared on the checkout page.
    Why: fee labels change; guessing them could misstate the total.
    Now: known fees are mapped (delivery, service, small order, bag, tip, donation); any other line stops the checkout.
14. **The 50p tolerance.**
    Symptom: confirm refused an unchanged basket because the total moved a few pence.
    Why: fees can change between preview and payment.
    Now: the basket must be identical, while the total may move by at most 50p.
15. **Never retry an unknown payment.**
    Symptom: the keypress was sent but no order page came.
    Why: the order may already exist; a second press can charge twice.
    Now: the code is already consumed, the tool stops and tells you to check your orders. A generic orders list does not count as success.
16. **Address that changes while loading.**
    Symptom: preview and confirm saw different "addresses" for the same delivery.
    Why: map attribution and delivery-option text load at different times inside the address block.
    Now: those lines are dropped; only street name and masked postcode are compared and shown. Unknown layouts return "(unreadable)" and stop.
17. **Location leaking through error messages.**
    Symptom: an error path printed the full feed URL, including a 12-character geohash (metre-level).
    Why: the happy path masked the postcode, the error path did not.
    Now: every printed URL passes an allowlist that keeps only `q`.
18. **Ratings formatted as money.**
    Symptom: a 4.8 rating showed as "0.05".
    Why: bare numbers were treated as pence.
    Now: ratings have their own formatter.

## Development

```
npm install      # dev dependency: @jackwener/opencli (for the registry in tests)
npm test         # node --test, no browser, no network
```

One test (`test/basket-struck.test.mjs`) needs real layout and is skipped unless `CHROMIUM_PATH` points at a Chromium binary and `playwright-core` is installed. It only renders a static fixture.

## License

Apache-2.0. See [LICENSE](LICENSE).

---

## 中文

opencli-deliveroo 是 [opencli](https://github.com/jackwener/opencli) 的一个用户适配器：在终端里通过你自己已登录的 Chrome 点 Deliveroo（英国）外卖。能看附近餐厅、看菜单、加减购物车、结账。付款必须用一次新的预览给出的一次性确认码，一个确认码只下一单。

- 与 Deliveroo 无任何关联，也未获其认可或支持。
- 自动化操作 Deliveroo 网站可能违反其服务条款，风险自负，你的账号可能被限制或封禁。
- 基于 jackwener 的 [opencli](https://github.com/jackwener/opencli)（Apache-2.0）。

### 手把手（不需要会编程）

在终端里输入命令：macOS 用「终端」，Windows 用 PowerShell，Linux 用任意终端。

1. **装 Node.js 20 以上**：到 <https://nodejs.org> 下载 LTS 版安装，新开终端运行 `node --version` 确认。
2. **装 opencli**（官方说明：<https://github.com/jackwener/opencli#readme>）：`npm install -g @jackwener/opencli`。macOS 和 Windows 也可以用官方桌面应用 OpenCLIApp（<https://opencli.info/download>）。
3. **给 Chrome 装 OpenCLI 扩展**：在 [Chrome 应用商店](https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk) 安装 **OpenCLI**，并在 `chrome://extensions` 里确认已启用。
4. **在同一个 Chrome 里登录 Deliveroo**：打开 <https://deliveroo.co.uk> 登录，确认账号里至少存了一个收货地址和一个付款方式。本工具从不替你登录。
5. **一条命令安装本适配器**：`npx github:Eridanus-Multiverse/opencli-deliveroo`。它会把适配器复制进 opencli 的适配器目录并做一次检查；以后再跑一遍就是更新。
6. **自检**（只读，随时可跑）：`opencli deliveroo doctor`。每行应显示 `ok` 或 `connected`，不是的话看 `next` 列，照做即可。
7. **试一下**：`opencli deliveroo restaurants pizza`。
8. **安全下单**：先加菜，再预览，再用预览给的码确认。
   ```
   opencli deliveroo add <第 7 步拿到的菜单链接> "Margherita"
   opencli deliveroo checkout
   opencli deliveroo checkout --confirm 1a2b3c4d
   ```
   预览不点任何会改动账号的东西，会列出整单并给一个 8 位确认码。确认码 10 分钟内有效、只能用一次，且购物车和总价必须仍然对得上；再预览一次旧码就作废。

平台差异：Windows PowerShell 可能报「此系统上禁止运行脚本」而拒绝运行 `npm`/`npx`，改用 `npm.cmd` / `npx.cmd`，或在「命令提示符」里运行。`npx github:...` 若提示缺 git，先到 <https://git-scm.com> 装 Git。设置环境变量：macOS/Linux 用 `export DELIVEROO_MAX_TOTAL=40`，PowerShell 用 `$env:DELIVEROO_MAX_TOTAL="40"`。

### 安全设计

- 默认只预览，`checkout` 不带 `--confirm` 什么都不付。
- 没有确认码就不付款；确认码绑定最近一次预览的购物车指纹和总价，10 分钟过期。
- 一个确认码只下一单：付款按键前一刻原子地消费掉确认码，两个并发的确认不可能都付款。
- 付款前重读页面：店、菜、数量、规格、单价必须一致，总价与预览相差不超过 50 便士，付款方式和街道级地址不变，小费和捐款为 0，不超过可选上限 `DELIVEROO_MAX_TOTAL`；每一分钱都要对账，出现认不出的费用行就停。
- Pay now 只按一次，结果不明绝不重试，请自己去 Deliveroo 看订单。
- 遇到登录页、PayPal 登录、3DS、验证码或人机验证立即停下，交还给你。
- 隐私：完整地址、电话、卡号不出页面；输出只有街道名和打码邮编；打印的链接只保留 `q` 参数。
- 局限：确认码是「人在回路」的减速带，不是身份认证；以你的用户身份运行的任何程序都能读到状态文件。早期版本只允许已保存的 PayPal，其他付款方式未经测试；网站一要 CVV、3DS 或登录就会停下，不会付款。

### 我们踩过的坑

1. 页面旧状态：`__NEXT_DATA__` 是服务端快照不会更新，改读实时 React/Redux store。
2. 重复导航被拒、借用别人的标签页：只读命令各开各的标签页，用完只关自己的。
3. 直接打开菜单页撞 Cloudflare：先落餐厅列表页，再用站内路由走过去；验证墙会被识别并停下。
4. 购物车条目不在状态里：状态里只有件数和店链接，条目要去菜单页侧栏读；读不到不等于空车。
5. 点错 Add：菜品弹窗里加料行也叫 Add，改点底部「to basket」那颗。
6. 误报加购成功：只认这道菜的数量按要求真的增加了；侧栏名字带规格，按开头匹配。
7. 规格点太快：套餐会长出新的必选组，一次点一个、等重画再点下一个。
8. 「Go to checkout」点了不走：先聚焦再发原生回车，再按加购弹窗里自己的 Go to checkout。
9. 按钮正则太严：打折时按钮写着两个金额加「incl. fees」，改为只认「Go to checkout」字样。
10. 合成回车没反应：必须 keyCode 13 加回车符，不走通用按键回退，不重试。
11. 看不到 Pay now：要先把结账各区段滚进视野，按钮才会出现。
12. 划线价：打折行同时有原价和现价，只认没有划线的那个，仍有歧义就停。
13. 未知费用行（比如袋子费）：已知费用逐项映射，认不出的一律停。
14. 50 便士容差：预览到付款之间费用会变，购物车必须完全相同，总价最多差 50 便士。
15. 付款结果不明绝不重试：订单可能已建，再按可能扣两次钱；通用订单列表页不算成功。
16. 地址块随加载变化：地图和送达选项文字会混进地址，统一剔除，只比街道名和打码邮编。
17. 报错泄露位置：错误分支曾原样打印带 12 位 geohash 的链接，现在所有链接只保留 `q`。
18. 评分被当成钱：4.8 星显示成 0.05，评分改用单独的格式化。
