# ozon-mcp-server (форк)

MCP-сервер для покупательского поиска на Ozon.ru: товары, карточки, отзывы.

Это **форк** [eduard256/ozon-mcp-server](https://github.com/eduard256/ozon-mcp-server) с четырьмя минимальными правками — для устойчивой работы с реального Windows-десктопа в 2026:

1. `browser.js` — `chromium.launch({ headless: false })` + полный chromium (вместо `chrome-headless-shell`). Variti в 2026 палит lite-сборку headless-shell, а полный chromium с настоящим рендерингом проходит challenge.
2. `browser.js` — UA Windows вместо Linux. Соответствует реальной системе.
3. `browser.js` — `chromium.launchPersistentContext()` вместо `launch + newContext`: cookies, localStorage и выбранный регион живут между запусками в `OZON_USER_DATA_DIR` (по умолчанию `~/.ozon-mcp-userdata`).
4. `ozon.js` — `details()` запросы делает последовательно вместо `Promise.all`. Variti режет два одновременных fetch на тот же продукт как бота → стабильный HTTP 403. Также — fallback на пустое описание, если page2 всё-таки не отдалась.

## Установка

```jsonc
// ~/.claude.json → mcpServers
"ozon": {
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "github:Pir0manT/ozon-mcp-server"],
  "env": {
    "OZON_CITY": "Ростов-на-Дону",
    "OZON_HIDE_WINDOW": "1"
  }
}
```

Перед первым использованием выполнить:

```bash
npx playwright@1.60.0 install chromium chromium-headless-shell
```

## Env-переменные

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `OZON_CITY` | (не задано) | После warmup попытается через UI выставить регион. Если у Ozon вёрстка изменилась — гасит warning, продолжает. Лучше задать вместе с persistent context. |
| `OZON_HIDE_WINDOW` | `1` | Окно chromium запускается за пределами экрана. Если `0` — окно видно (нужно для ручного выбора региона при первом запуске). |
| `OZON_USER_DATA_DIR` | `~/.ozon-mcp-userdata` | Куда сохранять cookies/storage между запусками. |

## Один раз настроить регион вручную

Если автоматический `OZON_CITY` не сработал (Ozon мог поменять вёрстку):

1. В `.claude.json` временно: `"OZON_HIDE_WINDOW": "0"`
2. `/mcp` → reconnect ozon → сделать любой запрос
3. В открытом окне chromium кликнуть на текущий регион в шапке и выбрать свой
4. Закрыть окно (или подождать idle timeout 10 мин)
5. Cookies сохранятся в `OZON_USER_DATA_DIR`
6. Вернуть `"OZON_HIDE_WINDOW": "1"` — дальше всё работает с правильными ценами автоматически

## Лицензия

MIT (как у оригинала). Спасибо [@eduard256](https://github.com/eduard256) за исходную реализацию.
