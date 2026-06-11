// Долгоживущий Chromium через Playwright, проходит anti-bot (Variti) Ozon'а
// один раз и переиспользуется для всего процесса. Запросы делаются как
// fetch() из контекста уже открытой главной страницы (same-origin) — словно
// расширение в открытой вкладке.
//
// ОТЛИЧИЕ ОТ eduard256/ozon-mcp-server:
//   1) headless: false — открывается ВИДИМОЕ окно полного chromium. Variti
//      палит chrome-headless-shell (lite-сборку без UI), а полный chromium
//      с настоящим рендерингом проходит challenge.
//   2) Windows UA вместо Linux — соответствует реальной системе (Lenovo).

import { chromium } from "playwright";

const HOME = "https://www.ozon.ru/";
const API = "https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=";
const CHALLENGE_WAIT_MS = 12000;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const NAV_TIMEOUT_MS = 90000;

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
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const log = (...a) => console.error("[browser]", ...a);

let browser = null;
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
  log("запускаю полный Chromium (headless: false)…");
  browser = await chromium.launch({ headless: false, args: LAUNCH_ARGS });
  browser.on("disconnected", () => {
    log("browser disconnected — перезапущусь на следующий запрос");
    browser = null;
    context = null;
    mainPage = null;
    challenged = false;
  });

  context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: USER_AGENT,
    locale: "ru-RU",
  });

  // ВАЖНО: НЕ блокируем stylesheet/image/font/media через context.route — Variti
  // anti-bot грузит свои скрипты/ассеты именно через эти типы запросов; если
  // их отрубить, challenge не пройдёт и Ozon вернёт 403 на composer-api.
  challenged = false;
}

async function ensureContext() {
  if (context && challenged) return context;
  if (initPromise) {
    await initPromise;
    return context;
  }
  initPromise = (async () => {
    if (!browser || !browser.isConnected()) await launch();
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
  try {
    await browser?.close();
  } catch {}
  context = null;
  browser = null;
}
