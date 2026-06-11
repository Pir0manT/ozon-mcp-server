// Долгоживущий Chromium через Playwright, проходит anti-bot (Variti) Ozon'а
// один раз и переиспользуется для всего процесса. Запросы делаются как
// fetch() из контекста уже открытой главной страницы (same-origin) — словно
// расширение в открытой вкладке.
//
// ОТЛИЧИЕ ОТ eduard256/ozon-mcp-server (4 правки):
//   1) headless: false — открывается ВИДИМОЕ окно полного chromium. Variti
//      палит chrome-headless-shell (lite-сборку без UI), а полный chromium
//      с настоящим рендерингом проходит challenge.
//   2) Windows UA вместо Linux — соответствует реальной системе (Lenovo).
//   3) launchPersistentContext: cookies/storage/userData живут между
//      запусками в OZON_USER_DATA_DIR (по умолчанию ~/.ozon-mcp-userdata).
//      Один раз выбрал свой город — навсегда.
//   4) OZON_CITY: после warmup пытается выставить регион через UI-кликами.
//      Best-effort: если селекторы Ozon-SPA поменялись — гасит warning в
//      stderr и продолжает. Persistent context страхует — даже если автомат
//      сломался, ранее выбранный город сохранён.

import { chromium } from "playwright";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = "https://www.ozon.ru/";
const API = "https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=";
const CHALLENGE_WAIT_MS = 12000;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const NAV_TIMEOUT_MS = 90000;

const USER_DATA_DIR = process.env.OZON_USER_DATA_DIR || join(homedir(), ".ozon-mcp-userdata");
const HIDE_WINDOW = process.env.OZON_HIDE_WINDOW !== "0";
const TARGET_CITY = (process.env.OZON_CITY || "").trim();

const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--mute-audio",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-background-networking",
  ...(HIDE_WINDOW
    ? ["--window-position=-32000,-32000"] // окно нормального размера 1920x1080, но за экраном
    : []),
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const log = (...a) => console.error("[browser]", ...a);

// persistent context — браузер и контекст объединены в один объект; browser
// получается через context.browser().
let context = null;
let mainPage = null;
let initPromise = null;
let challenged = false;
let idleTimer = null;

function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    log("idle timeout — закрываю браузер для освобождения RAM");
    shutdown().catch(() => {});
  }, IDLE_TIMEOUT_MS);
  idleTimer.unref();
}

async function launch() {
  log(`запускаю полный Chromium (headless: false, userDataDir: ${USER_DATA_DIR})…`);
  context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: LAUNCH_ARGS,
    viewport: { width: 1920, height: 1080 },
    userAgent: USER_AGENT,
    locale: "ru-RU",
  });
  context.browser()?.on("disconnected", () => {
    log("browser disconnected — перезапущусь на следующий запрос");
    context = null;
    mainPage = null;
    challenged = false;
  });

  // ВАЖНО: НЕ блокируем stylesheet/image/font/media через context.route — Variti
  // anti-bot грузит свои скрипты/ассеты именно через эти типы запросов; если
  // их отрубить, challenge не пройдёт и Ozon вернёт 403 на composer-api.
  challenged = false;
}

/**
 * Best-effort: попробовать выставить регион через UI на главной Ozon.
 * Селекторы хрупкие (SPA), при любой ошибке тихо продолжаем. Если у
 * persistent-context уже сохранены правильные cookies — это не нужно, и
 * мы это поймём по тому что кнопка локации уже показывает нужный город.
 */
async function trySetCity(page, city) {
  try {
    log(`пробую установить город "${city}"…`);
    // Кнопка локации в шапке. Реальные варианты разметки Ozon: data-widget
    // searchBarRegion, locationSelector, locationButton; кнопка с aria-label,
    // содержащим "Изменить" + "город"/"регион".
    const locBtn = page.locator(
      '[data-widget*="locationSelector" i], [data-widget*="region" i], ' +
        'button[aria-label*="ород"], button:has-text("Изменить")'
    );
    await locBtn.first().click({ timeout: 5000 });

    // Модалка с input. Ищем input в роли диалога.
    const input = page.locator(
      '[role="dialog"] input[type="text"], [role="dialog"] input[placeholder*="ород" i]'
    );
    await input.first().waitFor({ state: "visible", timeout: 5000 });
    await input.first().fill(city);
    // Подождать подсказки
    await page.waitForTimeout(1500);
    // Кликнуть первую подсказку
    const suggestion = page.locator(
      '[role="dialog"] [role="option"], [role="dialog"] li, [role="dialog"] [data-suggest], ' +
        '[role="dialog"] button:has-text("' + city + '")'
    );
    await suggestion.first().click({ timeout: 5000 });
    // Подождать пока Ozon применит и перерисует страницу
    await page.waitForTimeout(2500);
    log(`город "${city}" установлен`);
  } catch (e) {
    log(`не смог установить город автоматически (${e.message?.slice(0, 80)}); ` +
        `cookies из ${USER_DATA_DIR} остаются. Если регион важен — ` +
        `запусти один раз с OZON_HIDE_WINDOW=0 и выбери город вручную.`);
  }
}

async function ensureContext() {
  if (context && challenged) return context;
  if (initPromise) {
    await initPromise;
    return context;
  }
  initPromise = (async () => {
    if (!context || !context.browser()?.isConnected()) await launch();
    mainPage = await context.newPage();
    log("прохожу anti-bot challenge…");
    await mainPage.goto(HOME, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await mainPage.waitForTimeout(CHALLENGE_WAIT_MS);
    const title = await mainPage.title();
    if (/antibot|ограничен|доступ|нет соединения/i.test(title)) {
      throw new Error(`challenge не пройден (title: ${title})`);
    }
    challenged = true;
    log("challenge пройден:", title.slice(0, 40));
    if (TARGET_CITY) await trySetCity(mainPage, TARGET_CITY);
  })();
  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
  return context;
}

const DEAD =
  /Target page, context or browser has been closed|Session closed|Connection closed|browser has been closed/i;

/**
 * Fetch composer-api JSON по site-пути (например "/search/?text=...").
 * fetch() выполняется ИЗ открытой главной страницы (same-origin), что
 * автоматически даёт нужные cookies и Origin.
 */
export async function fetchJson(path, { retries = 1 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      resetIdle();
      await ensureContext();
      const body = await mainPage.evaluate(async (url) => {
        const r = await fetch(url, { headers: { accept: "application/json" } });
        return { status: r.status, text: await r.text() };
      }, API + encodeURIComponent(path));

      if (body.status !== 200) {
        if ((body.status === 403 || body.status === 307) && attempt < retries) {
          await shutdown();
          continue;
        }
        throw new Error(`Ozon вернул HTTP ${body.status}`);
      }
      return JSON.parse(body.text);
    } catch (err) {
      if (DEAD.test(String(err?.message)) && attempt < retries) {
        await shutdown();
        continue;
      }
      throw err;
    }
  }
}

export async function shutdown() {
  clearTimeout(idleTimer);
  challenged = false;
  mainPage = null;
  try {
    await context?.close();
  } catch {}
  context = null;
}
