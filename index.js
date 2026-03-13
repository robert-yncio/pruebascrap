import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { format } from 'util';
import { exec } from 'child_process';
import { promisify } from 'util';
import readline from 'readline';

dotenv.config();

const execAsync = promisify(exec);

/** Obtiene el código 2FA de forma dinámica: comando externo, archivo (polling) o .env estático. */
async function getTwoFactorCode() {
  const cmd = process.env.LINKEDIN_2FA_CMD || process.env.LINKEDIN_2FA_COMMAND;
  const filePath = process.env.LINKEDIN_2FA_CODE_FILE || process.env.LINKEDIN_2FA_FILE;
  const staticCode = (process.env.LINKEDIN_2FA_CODE || process.env.LINKEDIN_VERIFICATION_CODE || '').trim();

  if (cmd && typeof cmd === 'string' && cmd.trim()) {
    try {
      const { stdout } = await execAsync(cmd.trim(), { timeout: 60000, maxBuffer: 1024 });
      const code = (stdout || '').split('\n')[0].trim().replace(/\D/g, '') || (stdout || '').trim();
      if (code.length >= 4) return code;
    } catch (e) {
      console.log('Error ejecutando LINKEDIN_2FA_CMD:', e.message);
      return null;
    }
  }

  if (filePath && typeof filePath === 'string' && filePath.trim()) {
    const path = filePath.trim();
    const maxWaitMs = parseInt(process.env.LINKEDIN_2FA_FILE_WAIT, 10) || 120000;
    const pollIntervalMs = parseInt(process.env.LINKEDIN_2FA_FILE_POLL, 10) || 5000;
    const start = Date.now();
    console.log(`Esperando código 2FA en archivo ${path} (máx. ${maxWaitMs / 1000}s, polling cada ${pollIntervalMs / 1000}s)...`);
    let lastLog = 0;
    while (Date.now() - start < maxWaitMs) {
      try {
        if (existsSync(path)) {
          const content = fs.readFileSync(path, 'utf-8').trim();
          const code = content.replace(/\D/g, '') || content;
          if (code.length >= 4) {
            fs.writeFileSync(path, '', 'utf-8');
            return code;
          }
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, pollIntervalMs));
      const elapsed = Date.now() - start;
      if (elapsed - lastLog >= 15000) {
        lastLog = elapsed;
        console.log(`   Esperando código... (${Math.ceil((maxWaitMs - elapsed) / 1000)}s restantes)`);
      }
    }
    console.log('Tiempo agotado esperando código en archivo.');
    return null;
  }

  if (staticCode.length >= 4) return staticCode;

  // Si la consola es interactiva (TTY), pedir el código por teclado
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question('Introduce el código 2FA (y pulsa Enter): ', (answer) => {
        rl.close();
        const code = (answer || '').trim().replace(/\D/g, '') || (answer || '').trim();
        resolve(code.length >= 4 ? code : null);
      });
    });
  }

  return null;
}

// Historial de consola en history.log (cada ejecución se añade al archivo)
let historyLogStream = null;

function setupHistoryLog() {
  try {
    const logPath = join(process.cwd(), 'history.log');
    historyLogStream = fs.createWriteStream(logPath, { flags: 'a' });
    const runStart = new Date().toISOString();
    historyLogStream.write(`\n${'='.repeat(60)}\n`);
    historyLogStream.write(`[${runStart}] EJECUCIÓN INICIADA - process.argv: ${process.argv.slice(1).join(' ')}\n`);
    historyLogStream.write(`${'='.repeat(60)}\n`);

    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    function writeToHistory(level, args) {
      if (!historyLogStream) return;
      try {
        const msg = args.length > 0 ? format(...args) : '';
        const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
        historyLogStream.write(line);
      } catch (e) {}
    }

    function timestamp() {
      return new Date().toISOString();
    }

    console.log = function (...args) {
      writeToHistory('LOG', args);
      originalLog.apply(console, args.length ? [`[${timestamp()}]`, ...args] : [`[${timestamp()}]`]);
    };
    console.error = function (...args) {
      writeToHistory('ERROR', args);
      originalError.apply(console, args.length ? [`[${timestamp()}]`, ...args] : [`[${timestamp()}]`]);
    };
    console.warn = function (...args) {
      writeToHistory('WARN', args);
      originalWarn.apply(console, args.length ? [`[${timestamp()}]`, ...args] : [`[${timestamp()}]`]);
    };

    originalLog(`Historial de esta ejecución se guarda en: ${logPath}`);
  } catch (err) {
    process.stderr.write(`No se pudo crear history.log: ${err.message}\n`);
  }
}

class LinkedInScraper {
  constructor() {
    this.browser = null;
    this.page = null;
    this.cookiesFile = 'linkedin_cookies.json';
    this.headless = true; // por defecto para servidor; init() lo actualiza según HEADLESS env
  }

  async init(options = {}) {
    // Prioridad: opción pasada a init() > argumentos CLI (--headless / --no-headless / --browser) > .env (HEADLESS / SHOW_BROWSER)
    let isHeadless = options.headless;
    if (isHeadless === undefined) {
      const hasNoHeadless = process.argv.includes('--no-headless') || process.argv.includes('--browser') || process.argv.includes('--with-browser');
      const hasHeadless = process.argv.includes('--headless');
      if (hasNoHeadless) isHeadless = false;
      else if (hasHeadless) isHeadless = true;
      else {
        // Desde .env: SHOW_BROWSER=1 o BROWSER_VISIBLE=1 → con ventana; HEADLESS=0 o false → con ventana; resto → headless
        const showBrowser = /^(1|true|yes)$/i.test((process.env.SHOW_BROWSER || process.env.BROWSER_VISIBLE || '').trim());
        const headlessEnv = (process.env.HEADLESS || '').trim().toLowerCase();
        if (showBrowser || headlessEnv === 'false' || headlessEnv === '0' || headlessEnv === 'no') isHeadless = false;
        else isHeadless = true;
      }
    }
    if (isHeadless) {
      console.log('Iniciando navegador en modo headless (sin pantalla, para servidor Linux)...');
    } else {
      console.log('Iniciando navegador con interfaz...');
    }
    const args = isHeadless
      ? [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--no-first-run',
          '--window-size=1920,1080'
        ]
      : ['--start-maximized'];
    const launchOptions = {
      headless: isHeadless ? 'new' : false,
      defaultViewport: isHeadless ? { width: 1920, height: 1080 } : null,
      args
    };
    // Permite apuntar a un Chromium/Chrome del sistema vía CHROME_PATH o CHROMIUM_PATH en .env
    const executablePath = process.env.CHROME_PATH || process.env.CHROMIUM_PATH;
    if (executablePath) {
      launchOptions.executablePath = executablePath;
      console.log(`Usando Chrome/Chromium desde: ${executablePath}`);
    }
    this.browser = await puppeteer.launch(launchOptions);
    this.page = await this.browser.newPage();
    this.headless = isHeadless;

    // Configurar user agent para parecer más humano (Linux cuando headless)
    const userAgent = isHeadless
      ? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    await this.page.setUserAgent(userAgent);

    // Cargar cookies guardadas si existen
   await this.loadCookies();
  }

  // Guardar cookies de la sesión
  async saveCookies() {
    try {
      // Verificar que la página y el navegador estén disponibles
      if (!this.page || !this.browser) {
        return;
      }
      
      // Verificar que la página no esté cerrada
      if (this.page.isClosed()) {
        return;
      }
      
      // Intentar obtener cookies con timeout
      const cookies = await Promise.race([
        this.page.cookies(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))
      ]);
      
      if (cookies && cookies.length > 0) {
        fs.writeFileSync(this.cookiesFile, JSON.stringify(cookies, null, 2), 'utf-8');
        console.log('✓ Cookies guardadas');
      }
    } catch (error) {
      // Ignorar errores silenciosamente si el navegador está cerrando
      if (!error.message.includes('Target closed') && 
          !error.message.includes('Session closed') &&
          !error.message.includes('Requesting main frame too early')) {
        // Solo mostrar errores que no sean relacionados con el cierre del navegador
        console.log('⚠ No se pudieron guardar las cookies (navegador cerrando)');
      }
    }
  }

  /**
   * Guarda una captura de pantalla en carpeta interna para depuración (saber en qué pantalla está el browser).
   * Solo actúa si DEBUG_SCREENSHOTS=1 o true en .env. Las imágenes se guardan en ./screenshots/
   */
  async takeDebugScreenshot(stepName) {
    const enabled = /^(1|true|yes)$/i.test((process.env.DEBUG_SCREENSHOTS || '').trim());
    if (!enabled || !this.page || this.page.isClosed()) return;
    try {
      const dir = join(process.cwd(), 'screenshots');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const safe = (stepName || 'screen').replace(/[^\w\-]/g, '_');
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const path = join(dir, `${safe}_${ts}.png`);
      await this.page.screenshot({ path, type: 'png' });
      console.log(`[DEBUG] Captura guardada: ${path}`);
    } catch (e) {
      // No fallar el flujo por un error al guardar la captura
    }
  }

  // Cargar cookies guardadas
  async loadCookies() {
    try {
      if (existsSync(this.cookiesFile)) {
        const cookies = JSON.parse(fs.readFileSync(this.cookiesFile, 'utf-8'));
        await this.page.setCookie(...cookies);
        console.log('✓ Cookies cargadas desde sesión anterior');
        return true;
      }
      return false;
    } catch (error) {
      console.log('No se encontraron cookies guardadas o error al cargarlas');
      return false;
    }
  }

  // Verificar si la sesión está activa
  async isSessionActive() {
    try {
      // Ir a la página principal de LinkedIn
      await this.page.goto('https://www.linkedin.com/feed', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      await this.page.waitForTimeout(2000);
      await this.takeDebugScreenshot('01_sesion_verificando_feed');

      // Verificar si estamos logueados (no en checkpoint/verificación)
      const currentUrl = this.page.url();
      if (currentUrl.includes('/checkpoint/')) return false;
      const hasSearchBar = await this.page.$('input[aria-label*="Buscar"]') !== null;
      const hasNavBar = await this.page.$('nav[role="navigation"]') !== null;
      const isOnFeed = currentUrl.includes('feed') || currentUrl.includes('mynetwork');
      const notOnLogin = !currentUrl.includes('/login');

      return (isOnFeed || hasSearchBar || hasNavBar) && notOnLogin;
    } catch (error) {
      console.log('Error verificando sesión:', error.message);
      return false;
    }
  }

  async login(email, password) {
    try {
      console.log('Iniciando sesión en LinkedIn...');
      await this.page.goto('https://www.linkedin.com/login', {
        waitUntil: 'domcontentloaded',
        timeout: 90000
      });

      // Esperar a que la página cargue completamente
      await this.page.waitForTimeout(2000);

      // Esperar y llenar el formulario de login con múltiples selectores posibles
      const usernameSelector = '#username, input[name="session_key"]';
      const passwordSelector = '#password, input[name="session_password"]';
      
      await this.page.waitForSelector(usernameSelector, { timeout: 30000 });
      await this.page.waitForSelector(passwordSelector, { timeout: 30000 });
      
      // Limpiar campos y escribir con delays para parecer más humano
      await this.page.click(usernameSelector);
      await this.page.keyboard.down('Control');
      await this.page.keyboard.press('KeyA');
      await this.page.keyboard.up('Control');
      await this.page.type(usernameSelector, email, { delay: 100 });
      
      await this.page.waitForTimeout(500);
      
      await this.page.click(passwordSelector);
      await this.page.keyboard.down('Control');
      await this.page.keyboard.press('KeyA');
      await this.page.keyboard.up('Control');
      await this.page.type(passwordSelector, password, { delay: 100 });
      
      await this.page.waitForTimeout(1000);
      
      // Hacer clic en el botón de login
      const submitButton = 'button[type="submit"], button[data-litms-control-urn="login-submit"]';
      await this.page.waitForSelector(submitButton, { timeout: 10000 });
      await this.page.click(submitButton);
      
      console.log('Esperando respuesta del servidor...');
      
      // En headless la navegación a veces no dispara eventos; limitar espera y luego comprobar URL
      const navTimeoutMs = this.headless ? 25000 : 60000;
      const minWaitMs = this.headless ? 8000 : 3000;
      try {
        await Promise.race([
          this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: navTimeoutMs }),
          this.page.waitForSelector('input[aria-label*="Buscar"]', { timeout: navTimeoutMs }),
          this.page.waitForSelector('nav[role="navigation"]', { timeout: navTimeoutMs }),
          new Promise(resolve => setTimeout(resolve, navTimeoutMs))
        ]);
      } catch (navError) {
        console.log('Timeout en navegación, verificando estado...');
      }
      await this.page.waitForTimeout(minWaitMs);

      // Verificar si el login fue exitoso (LinkedIn a veces redirige a /checkpoint/challenge con retraso)
      let currentUrl = this.page.url();
      console.log(`URL actual: ${currentUrl}`);
      if (!currentUrl.includes('/checkpoint/') && !currentUrl.includes('/feed') && !currentUrl.includes('mynetwork')) {
        await this.page.waitForTimeout(2000);
        currentUrl = this.page.url();
        console.log(`URL tras espera (por redirección tardía): ${currentUrl}`);
      }
      
      // LinkedIn puede redirigir a verificación de seguridad (checkpoint) o "No soy un robot" (reCAPTCHA)
      let isCheckpoint = currentUrl.includes('/checkpoint/');
      const isCheckpointChallenge = currentUrl.includes('/checkpoint/challenge');
      const pageTitle = await this.page.title().catch(() => '');
      const isSecurityVerification = pageTitle.includes('Verificación de seguridad');

      // Si estamos en checkpoint/challenge, dar tiempo a que cargue el contenido (2FA, app o reCAPTCHA)
      if (isCheckpointChallenge) {
        await this.page.waitForTimeout(2500);
        currentUrl = this.page.url();
        if (currentUrl.includes('/checkpoint/')) isCheckpoint = true;
        await this.takeDebugScreenshot('checkpoint');
      }

      // Detectar pantalla "Echa un vistazo a la aplicación de LinkedIn" (confirmar por app) y hacer clic en "Verificar por SMS"
      let clickedVerifyBySms = false;
      try {
        const isAppNotificationScreen = await this.page.evaluate(() => {
          const bodyText = (document.body && document.body.innerText) ? document.body.innerText : '';
          const t = bodyText.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          const hasAppTitle = t.includes('echa un vistazo') && t.includes('aplicacion');
          const hasNotification = t.includes('notificacion') && (t.includes('dispositivos') || t.includes('sesion'));
          const hasVerifySms = t.includes('verificar por sms') || t.includes('verify by sms');
          return (hasAppTitle || hasNotification) && (hasVerifySms || t.includes('volver a enviar'));
        });
        if (isAppNotificationScreen) {
          await this.takeDebugScreenshot('app_notification');
          console.log('⚠ LinkedIn pide confirmar por la app. Haciendo clic en "Verificar por SMS" para recibir el código...');
          clickedVerifyBySms = await this.page.evaluate(() => {
            const candidates = document.querySelectorAll('a, button, [role="button"], [role="link"], span[class*="link"]');
            for (const el of candidates) {
              const text = (el.innerText || el.textContent || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
              if (text === 'verificar por sms' || text === 'verify by sms' || (text.includes('verificar por sms') && text.length < 25) || (text.includes('verify by sms') && text.length < 25)) {
                el.click();
                return true;
              }
            }
            for (const el of candidates) {
              const text = (el.innerText || el.textContent || '').trim().toLowerCase();
              if (text.includes('sms') && (text.includes('verificar') || text.includes('verify')) && text.length < 35) {
                el.click();
                return true;
              }
            }
            return false;
          });
          if (clickedVerifyBySms) {
            await this.page.waitForTimeout(4000);
            currentUrl = this.page.url();
            console.log('Esperando pantalla de código SMS...');
          }
        }
      } catch (e) {}

      // Detectar pantalla de código 2FA (código enviado al teléfono) por texto Y por elementos del formulario
      let isTwoFactorCodeStep = false;
      try {
        isTwoFactorCodeStep = await this.page.evaluate(() => {
          const bodyText = (document.body && document.body.innerText) ? document.body.innerText : '';
          const t = bodyText.toLowerCase().normalize('NFD').replace(/\u0307/g, '').replace(/[\u0300-\u036f]/g, '');
          const hasCodeText = t.includes('introduce el codigo') || t.includes('codigo que te hemos enviado') || t.includes('telefono acabado en') || t.includes('code we sent') || t.includes('verification code') || t.includes('codigo de verificacion');
          const hasDeviceText = t.includes('reconocer este dispositivo') || t.includes('recognize this device');
          const hasResendText = t.includes('reenviar por sms') || t.includes('reenviar por llamada') || t.includes('resend');
          const hasEnviarButton = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]')).some(el => (el.innerText || el.value || '').toLowerCase().includes('enviar') || (el.innerText || el.value || '').toLowerCase().includes('submit'));
          const codeInput = document.querySelector('input[type="text"]:not([type="hidden"]), input[type="number"], input:not([type="hidden"]):not([type="submit"])');
          const hasCodeInput = codeInput && (document.body.contains(codeInput));
          return (hasCodeText || (hasDeviceText && hasResendText)) || (hasEnviarButton && hasCodeInput);
        });
      } catch (e) {}

      if (isTwoFactorCodeStep) await this.takeDebugScreenshot('2fa_code');

      // Detectar pantalla "No soy un robot" (reCAPTCHA) - solo si no es 2FA
      let isRecaptchaSecurityStep = false;
      if (!isTwoFactorCodeStep) {
        try {
          isRecaptchaSecurityStep = await this.page.evaluate(() => {
            const bodyText = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
            const hasRobotText = bodyText.includes('no soy un robot') || bodyText.includes("i'm not a robot");
            const hasSecurityCheckText = bodyText.includes('comprobación rápida de seguridad') || bodyText.includes('vamos a hacer una comprobación');
            const hasRecaptchaIframe = document.querySelector('iframe[src*="recaptcha"]') !== null || document.querySelector('iframe[src*="google.com/recaptcha"]') !== null;
            return (hasRobotText || hasSecurityCheckText) || hasRecaptchaIframe;
          });
        } catch (e) {}
      }

      if (isRecaptchaSecurityStep) await this.takeDebugScreenshot('recaptcha');

      const isCaptchaOrChallengeStep = isCheckpointChallenge || isRecaptchaSecurityStep;

      const isHeadless = this.headless === true;

      if (isCheckpoint || isSecurityVerification || isRecaptchaSecurityStep) {
        if (isTwoFactorCodeStep) {
          console.log('⚠ LinkedIn solicita el código de verificación enviado a tu teléfono (2FA).');
          const twoFactorCode = await getTwoFactorCode();
          if (twoFactorCode && twoFactorCode.length >= 4) {
            try {
              const submitted = await this.page.evaluate((code) => {
                const input = document.querySelector('input[type="text"]:not([type="hidden"]), input[type="number"], input[name*="pin"], input[name*="code"], input:not([type="hidden"]):not([type="submit"])');
                const btn = Array.from(document.querySelectorAll('button, input[type="submit"]')).find(el => (el.innerText || el.value || '').toLowerCase().includes('enviar') || (el.innerText || el.value || '').toLowerCase().includes('submit'));
                if (input && btn) {
                  input.focus();
                  input.value = String(code).trim();
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                  btn.click();
                  return true;
                }
                return false;
              }, twoFactorCode.trim());
              if (submitted) {
                console.log('Código 2FA enviado. Esperando redirección...');
                await this.page.waitForTimeout(5000);
                const afterUrl = this.page.url();
                if (!afterUrl.includes('/checkpoint/')) {
                  console.log('✓ Verificación 2FA completada. Login exitoso.');
                  await this.saveCookies();
                  return true;
                }
                console.log('Código posiblemente incorrecto o sesión sigue en checkpoint.');
              }
            } catch (e) {
              console.log('No se pudo enviar el código 2FA:', e.message);
              if (isHeadless) {
                console.log('✗ En servidor sin pantalla revisa LINKEDIN_2FA_CODE_FILE o LINKEDIN_2FA_CMD.');
                return false;
              }
            }
          }
          if (isHeadless) {
            await this.takeDebugScreenshot('login_blocked_2fa');
            console.log('✗ En servidor sin pantalla necesitas código 2FA dinámico:');
            console.log('  - LINKEDIN_2FA_CODE_FILE=ruta/archivo.txt  (escribe el código en el archivo al recibir el SMS; se lee y se borra)');
            console.log('  - LINKEDIN_2FA_CMD="comando que imprime el código"  (ej. script que lee de API/SMS)');
            console.log('  - LINKEDIN_2FA_CODE=123456  (solo para esta ejecución; cambia en cada intento)');
            return false;
          }
          console.log('Introduce el código en el navegador (haz clic en el campo, escribe y pulsa Enviar). Comprobando cada 15 s hasta 5 minutos...');
        } else if (isCaptchaOrChallengeStep) {
          if (isHeadless) {
            await this.takeDebugScreenshot('login_blocked_captcha');
            console.log('✗ LinkedIn muestra CAPTCHA ("No soy un robot"). En servidor sin pantalla no se puede resolver.');
            console.log('Solución: haz login una vez en un PC con navegador, guarda linkedin_cookies.json y súbelo al servidor; o usa una sesión con cookies válidas.');
            return false;
          }
          console.log('⚠ LinkedIn muestra verificación "No soy un robot" / comprobación rápida de seguridad (CAPTCHA).');
          console.log('Marca la casilla en el navegador y resuélvela. Comprobando cada 15 s hasta 5 minutos...');
        } else {
          if (isHeadless) {
            await this.takeDebugScreenshot('login_blocked_verification');
            console.log('✗ LinkedIn solicita verificación de seguridad. En servidor sin pantalla no se puede completar.');
            return false;
          }
          console.log('⚠ LinkedIn está solicitando verificación de seguridad (p. ej. escaneo o comprobación).');
          console.log('Complétala en el navegador. Comprobando cada 15 s hasta 5 minutos...');
        }
        const maxWaitMs = 5 * 60 * 1000;   // 5 minutos (solo con interfaz)
        const checkIntervalMs = 15 * 1000;  // 15 segundos
        const start = Date.now();
        while (Date.now() - start < maxWaitMs) {
          await this.page.waitForTimeout(checkIntervalMs);
          const newUrl = this.page.url();
          const newTitle = await this.page.title().catch(() => '');
          let stillRecaptcha = false;
          try {
            stillRecaptcha = await this.page.evaluate(() => {
              const bodyText = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
              const hasRobot = bodyText.includes('no soy un robot') || bodyText.includes("i'm not a robot");
              const hasSecurity = bodyText.includes('comprobación rápida de seguridad') || bodyText.includes('vamos a hacer una comprobación');
              const hasRecaptcha = document.querySelector('iframe[src*="recaptcha"]') !== null || document.querySelector('iframe[src*="google.com/recaptcha"]') !== null;
              return (hasRobot || hasSecurity) || hasRecaptcha;
            });
          } catch (e) {}
          if (!newUrl.includes('/checkpoint/') && !newTitle.includes('Verificación de seguridad') && !stillRecaptcha) {
            console.log('✓ Verificación completada. Login exitoso.');
            await this.saveCookies();
            return true;
          }
          const restante = Math.ceil((maxWaitMs - (Date.now() - start)) / 60000);
          console.log(`   Esperando... (hasta ${restante} min restantes)`);
        }
        console.log('✗ Tiempo agotado. Vuelve a ejecutar cuando hayas completado la verificación.');
        return false;
      }
      
      // Verificar múltiples indicadores de login exitoso (excluyendo checkpoint)
      const isLoggedIn = (currentUrl.includes('feed') || 
                        currentUrl.includes('mynetwork') ||
                        currentUrl.includes('/in/') ||
                        !currentUrl.includes('/login')) && !isCheckpoint;
      
      // Verificar también por elementos de la página principal
      const hasSearchBar = await this.page.$('input[aria-label*="Buscar"]') !== null;
      const hasNavBar = await this.page.$('nav[role="navigation"]') !== null;
      
      if (isLoggedIn || hasSearchBar || hasNavBar) {
        console.log('✓ Login exitoso');
        await this.takeDebugScreenshot('02_login_exitoso');
        // Guardar cookies después de login exitoso
        await this.saveCookies();
        return true;
      } else {
        // Verificar si hay CAPTCHA, "No soy un robot" o desafío
        const hasCaptcha = await this.page.$('iframe[title*="challenge"]') !== null ||
                          await this.page.$('div[class*="challenge"]') !== null;
        let hasRecaptchaRobot = false;
        try {
          hasRecaptchaRobot = await this.page.evaluate(() => {
            const bodyText = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
            const hasRobot = bodyText.includes('no soy un robot') || bodyText.includes("i'm not a robot");
            const hasSecurity = bodyText.includes('comprobación rápida de seguridad') || bodyText.includes('vamos a hacer una comprobación');
            const hasRecaptcha = document.querySelector('iframe[src*="recaptcha"]') !== null;
            return (hasRobot || hasSecurity) || hasRecaptcha;
          });
        } catch (e) {}

        if (hasCaptcha || hasRecaptchaRobot) {
          if (this.headless) {
            console.log('✗ LinkedIn muestra CAPTCHA. En servidor sin pantalla no se puede resolver.');
            console.log('Solución: haz login en un PC, guarda linkedin_cookies.json y úsalo en el servidor.');
            return false;
          }
          if (hasRecaptchaRobot) {
            console.log('⚠ LinkedIn muestra "No soy un robot" / comprobación rápida de seguridad. Resuélvelo en el navegador.');
          } else {
            console.log('⚠ LinkedIn está solicitando verificación (CAPTCHA). Por favor, resuélvelo manualmente en el navegador.');
          }
          console.log('Esperando 30 segundos para que resuelvas la verificación...');
          await this.page.waitForTimeout(30000);

          // Verificar nuevamente después del delay
          const newUrl = this.page.url();
          if ((newUrl.includes('feed') || newUrl.includes('mynetwork') || !newUrl.includes('/login')) && !newUrl.includes('/checkpoint/')) {
            console.log('✓ Login exitoso después de la verificación');
            await this.saveCookies();
            return true;
          }
        }

        console.log('✗ Error en el login. Verifica tus credenciales o resuelve el CAPTCHA / "No soy un robot" manualmente.');
        return false;
      }
    } catch (error) {
      console.error('Error durante el login:', error.message);
      console.log('Verifica que las credenciales sean correctas y que no haya CAPTCHA.');
      return false;
    }
  }

  async searchPerson(name, options = {}) {
    try {
      const { 
        filterKeywords = null, // Array de palabras clave para filtrar
        getFullDetails = false, // Obtener detalles completos automáticamente
        maxResults = 25, // Máximo de resultados a obtener
        exclusionUrls = [] // Array de URLs de LinkedIn para excluir
      } = options;
      
      console.log(`Buscando: ${name}...`);
      if (filterKeywords && filterKeywords.length > 0) {
        console.log(`Palabras clave para priorizar barrido: ${filterKeywords.join(', ')}`);
      }
      
      // Construir query para LinkedIn: solo el título del puesto.
      // Las keywords NO se añaden al URL porque suelen ser subconjuntos del título
      // (ej. título="Jefe de proyectos", keywords=["jefe","proyectos",...]) lo que
      // genera queries redundantes y muy restrictivas que devuelven 0-4 resultados.
      // Las keywords se usan solo para priorizar/ordenar localmente los perfiles extraídos.
      const titleOnly = (name || '').trim();
      let searchQuery = titleOnly;
      const maxQueryLength = 180;
      if (searchQuery.length > maxQueryLength) {
        searchQuery = searchQuery.substring(0, maxQueryLength).trim();
      }
      // geoUrn Perú: 102927786 — restringe búsqueda a Perú
      const geoPeru = 'geoUrn=%5B%22102927786%22%5D';
      let searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(searchQuery)}&origin=SWITCH_SEARCH_VERTICAL&${geoPeru}`;
      console.log(`Query enviada a LinkedIn: ${searchQuery.substring(0, 80)}${searchQuery.length > 80 ? '...' : ''}`);
      await this.page.goto(searchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 90000
      });

      // Verificar que estamos en la página correcta (no en verificación de seguridad)
      const currentUrl = this.page.url();
      console.log(`URL actual: ${currentUrl}`);
      
      if (currentUrl.includes('/checkpoint/')) {
        const pageTitle = await this.page.title().catch(() => '');
        if (pageTitle.includes('Verificación de seguridad')) {
          console.log('⚠ LinkedIn redirigió a verificación de seguridad. Complétala en el navegador.');
          console.log('Comprobando cada 15 s hasta 5 minutos...');
          const maxWaitMs = 5 * 60 * 1000;
          const checkIntervalMs = 15 * 1000;
          const start = Date.now();
          let superado = false;
          while (Date.now() - start < maxWaitMs) {
            await this.page.waitForTimeout(checkIntervalMs);
            const newUrl = this.page.url();
            const newTitle = await this.page.title().catch(() => '');
            if (!newUrl.includes('/checkpoint/') && !newTitle.includes('Verificación de seguridad')) {
              superado = true;
              console.log('✓ Verificación completada.');
              break;
            }
            const restante = Math.ceil((maxWaitMs - (Date.now() - start)) / 60000);
            console.log(`   Esperando... (hasta ${restante} min restantes)`);
          }
          if (!superado) {
            console.log('✗ Tiempo agotado. No se pueden obtener resultados.');
            return [];
          }
          // Reintentar la búsqueda tras superar el checkpoint
          await this.page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
          await this.page.waitForTimeout(3000);
        }
      }
      
      // Esperar a que carguen los resultados con múltiples selectores posibles
      console.log('Esperando a que carguen los resultados...');
      try {
        await Promise.race([
          this.page.waitForSelector('div[data-view-name="people-search-result"]', { timeout: 15000 }),
          this.page.waitForSelector('.search-results-container', { timeout: 15000 }),
          this.page.waitForSelector('.reusable-search__result-container', { timeout: 15000 }),
          this.page.waitForSelector('ul.reusable-search__entity-result-list', { timeout: 15000 }),
          this.page.waitForSelector('[class*="search-result"]', { timeout: 15000 }),
          this.page.waitForSelector('li[class*="result"]', { timeout: 15000 }),
          this.page.waitForSelector('div[class*="entity-result"]', { timeout: 15000 }),
          this.page.waitForSelector('a[data-view-name="search-result-lockup-title"]', { timeout: 15000 })
        ]);
        console.log('✓ Contenedor de resultados encontrado');
      } catch (selectorError) {
        console.log('⚠ No se encontró el contenedor esperado, continuando...');
      }
      
      // Esperar un poco más para que carguen todos los elementos
      await this.page.waitForTimeout(4000);
      
      // Hacer scroll para cargar más resultados
      console.log('Haciendo scroll para cargar más resultados...');
      await this.page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight / 3);
      });
      await this.page.waitForTimeout(2000);
      await this.page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight / 2);
      });
      await this.page.waitForTimeout(2000);
      await this.page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await this.page.waitForTimeout(2000);

      // Extraer información de los perfiles (página 1)
      console.log('Extrayendo información de perfiles (página 1)...');
      await this.takeDebugScreenshot('03_busqueda_hoja_01');
      const rawPage1 = await this._extractProfilesFromCurrentPage();

      // Aplicar exclusiones en hoja 1 antes de contar: los excluidos no cuentan para el límite
      let profiles = [];
      const seenUrlsGlobal = new Set();
      let excludedPage1 = 0;
      for (const p of rawPage1) {
        const url = (p.urlPerfil || '').trim();
        if (url) seenUrlsGlobal.add(url);
        if (exclusionUrls && exclusionUrls.length > 0 && shouldExcludeProfile(p, exclusionUrls)) {
          excludedPage1++;
        } else {
          profiles.push(p);
        }
      }
      if (excludedPage1 > 0) {
        console.log(`  Hoja 1: ${excludedPage1} excluidos antes de contar → ${profiles.length} válidos disponibles`);
      }
      console.log(`Perfiles válidos en hoja 1: ${profiles.length} (necesarios: ${maxResults})`);

      // Detectar paginador
      await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await this.page.waitForTimeout(2000);
      const paginationInfo = await this.page.evaluate(() => {
        const pag = document.querySelector('.artdeco-pagination');
        if (!pag) return { totalPages: 1, pageSize: 10 };
        const indicators = pag.querySelectorAll('li.artdeco-pagination__indicator');
        let totalPages = 1;
        const numbers = [];
        indicators.forEach(li => {
          const n = parseInt(li.innerText, 10);
          if (!isNaN(n)) numbers.push(n);
        });
        if (numbers.length > 0) totalPages = Math.max(...numbers);
        const nextBtn = pag.querySelector('.artdeco-pagination__button--next');
        const hasNext = nextBtn && nextBtn.getAttribute('aria-disabled') !== 'true' && !nextBtn.disabled;
        if (totalPages === 1 && hasNext) totalPages = 2;
        return { totalPages, pageSize: 10 };
      });
      const pageSize = rawPage1.length >= 25 ? 25 : (rawPage1.length > 0 ? 10 : 10);
      paginationInfo.pageSize = pageSize;

      console.log(`Paginador: ${paginationInfo.totalPages} hoja(s) detectada(s).`);

      // Paginar solo si los perfiles válidos (no excluidos) no alcanzan el límite
      if (profiles.length >= maxResults) {
        console.log(`Hoja 1 ya tiene ${profiles.length} perfiles válidos (límite: ${maxResults}). No se necesita paginar.`);
      } else if (paginationInfo.totalPages > 1) {
        const baseSearchUrl = searchUrl.replace(/\&start=\d+/, '').replace(/\?start=\d+&/, '?').replace(/\?start=\d+$/, '');
        const separator = baseSearchUrl.includes('?') ? '&' : '?';
        const MAX_EMPTY_PAGES = 10;
        let consecutiveEmptyPages = 0;

        for (let pageNum = 2; pageNum <= paginationInfo.totalPages; pageNum++) {
          const start = (pageNum - 1) * paginationInfo.pageSize;
          const pageUrl = `${baseSearchUrl}${separator}start=${start}`;

          console.log(`\n──── Hoja ${pageNum}/${paginationInfo.totalPages} ────`);
          console.log(`  [1/4] Navegando a la hoja ${pageNum} (start=${start})... (válidos acumulados: ${profiles.length}/${maxResults})`);
          await this.page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
          await this.page.waitForTimeout(4000);

          console.log(`  [2/4] Haciendo scroll para revelar todos los resultados...`);
          await this.page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight / 2); });
          await this.page.waitForTimeout(1500);
          await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await this.page.waitForTimeout(1500);

          console.log(`  [3/4] Extrayendo perfiles de la hoja ${pageNum}...`);
          await this.takeDebugScreenshot(`03_busqueda_hoja_${String(pageNum).padStart(2, '0')}`);
          const pageProfiles = await this._extractProfilesFromCurrentPage();

          console.log(`  [4/4] Filtrando duplicados y excluidos: ${pageProfiles.length} encontrados en esta hoja...`);
          let added = 0;
          let skippedDup = 0;
          let skippedExcl = 0;
          for (const p of pageProfiles) {
            const url = (p.urlPerfil || '').trim();
            if (url && seenUrlsGlobal.has(url)) {
              skippedDup++;
              continue;
            }
            if (url) seenUrlsGlobal.add(url);
            if (exclusionUrls && exclusionUrls.length > 0 && shouldExcludeProfile(p, exclusionUrls)) {
              skippedExcl++;
              continue;
            }
            profiles.push(p);
            added++;
          }
          console.log(`  ✔ Hoja ${pageNum}: ${added} nuevos válidos, ${skippedDup} duplicados, ${skippedExcl} excluidos → válidos acumulados: ${profiles.length}/${maxResults}`);

          // Parar en cuanto tengamos suficientes perfiles válidos (no excluidos)
          if (profiles.length >= maxResults) {
            console.log(`\n  ✓ Límite de ${maxResults} perfiles válidos alcanzado en hoja ${pageNum}. Deteniendo paginación.`);
            break;
          }

          // Parar si hay demasiadas páginas vacías consecutivas
          if (pageProfiles.length === 0) {
            consecutiveEmptyPages++;
            console.log(`  ⚠ Hoja vacía (${consecutiveEmptyPages}/${MAX_EMPTY_PAGES} consecutivas sin resultados)`);
            if (consecutiveEmptyPages >= MAX_EMPTY_PAGES) {
              console.log(`  ✗ ${MAX_EMPTY_PAGES} hojas consecutivas sin perfiles. Deteniendo paginación.`);
              break;
            }
          } else {
            consecutiveEmptyPages = 0;
            const faltantes = maxResults - profiles.length;
            if (faltantes > 0) {
              console.log(`  → Faltan ${faltantes} perfiles válidos para completar el límite. Continuando a hoja ${pageNum + 1}...`);
            }
          }
        }
      }

      console.log(`Perfiles válidos encontrados (todas las hojas): ${profiles.length}`);
      
      // Fallback: si 0 perfiles y la query incluía keywords, reintentar solo con el título del puesto
      if (profiles.length === 0 && titleOnly && searchQuery !== titleOnly) {
        const fallbackUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(titleOnly)}&origin=SWITCH_SEARCH_VERTICAL&${geoPeru}`;
        console.log('⚠ Reintentando búsqueda solo con el título del puesto...');
        await this.page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await this.page.waitForTimeout(5000);
        try {
          await Promise.race([
            this.page.waitForSelector('div[data-view-name="people-search-result"]', { timeout: 20000 }),
            this.page.waitForSelector('.reusable-search__result-container', { timeout: 20000 }),
            this.page.waitForSelector('div[class*="entity-result"]', { timeout: 20000 }),
            this.page.waitForSelector('a[href*="/in/"]', { timeout: 20000 })
          ]);
        } catch (e) { /* continuar */ }
        await this.page.waitForTimeout(3000);
        await this.page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight / 2); });
        await this.page.waitForTimeout(2000);
        await this.page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); });
        await this.page.waitForTimeout(2000);
        const profilesFallback = await this.page.evaluate(() => {
          const results = [];
          const selectors = ['div[data-view-name="people-search-result"]', 'li.entity-result__item', '.reusable-search__result-container', 'li[class*="result"]', 'div[class*="entity-result"]'];
          let cards = [];
          for (const sel of selectors) {
            const found = document.querySelectorAll(sel);
            if (found.length > 0) { cards = Array.from(found); break; }
          }
          if (cards.length === 0) {
            const links = document.querySelectorAll('a[href*="/in/"]');
            links.forEach(link => {
              if (link.href && link.href.includes('/in/') && !link.href.includes('/in/feed')) {
                const card = link.closest('li') || link.closest('div') || link.parentElement;
                if (card && !cards.includes(card)) cards.push(card);
              }
            });
          }
          cards.forEach(card => {
            try {
              const isServices = (t) => !t || (typeof t === 'string' && (t.trim().toLowerCase().startsWith('ofrece servicios') || t.trim().toLowerCase().startsWith('services') || (t.split(',').length >= 3 && t.length > 50)));
              let nameEl = null;
              const links = card.querySelectorAll('a[data-view-name="search-result-lockup-title"], .entity-result__title-text a, a[href*="/in/"]');
              for (const el of links) {
                const text = (el.innerText || '').trim();
                const aria = (el.getAttribute('aria-label') || '').trim();
                if (aria && /^Ver perfil de\s+/i.test(aria)) { nameEl = el; break; }
                if (text.length > 0 && !isServices(text)) { nameEl = el; break; }
              }
              if (!nameEl && links.length > 0) nameEl = links[0];
              let name = nameEl && nameEl.innerText ? nameEl.innerText.trim() : 'N/A';
              if (isServices(name)) name = 'N/A';
              if (name === 'N/A' && nameEl) {
                const ariaLabel = nameEl.getAttribute('aria-label');
                if (ariaLabel) name = ariaLabel.replace(/^Ver perfil de\s*/i, '').trim();
              }
              const profileUrl = nameEl && nameEl.href ? nameEl.href.split('?')[0] : '';
              const titleEl = card.querySelector('.entity-result__primary-subtitle, [class*="subtitle"]');
              const title = titleEl ? titleEl.innerText.trim() : 'N/A';
              const locEl = card.querySelector('.entity-result__secondary-subtitle, [class*="location"]');
              const location = locEl ? locEl.innerText.trim() : 'N/A';
              const imgEl = card.querySelector('img');
              if ((name !== 'N/A' && name.length > 0) || (profileUrl && profileUrl.includes('/in/'))) {
                results.push({ nombre: name, titulo: title, ubicacion: location, descripcion: 'N/A', urlPerfil: profileUrl || 'N/A', imagenPerfil: imgEl ? imgEl.src : 'N/A' });
              }
            } catch (err) {}
          });
          return results;
        });
        if (profilesFallback.length > 0) {
          profiles.push(...profilesFallback);
          console.log(`✓ Fallback: se obtuvieron ${profilesFallback.length} perfiles con búsqueda por título. Se aplicarán filtros por palabras clave.`);
        }
      }
      
      // Si aún no hay perfiles, diagnóstico
      if (profiles.length === 0) {
        console.log('⚠ No se encontraron perfiles. Realizando diagnóstico...');
        const diagnostic = await this.page.evaluate(() => ({
          url: window.location.href,
          title: document.title,
          hasSearchContainer: !!document.querySelector('.search-results-container'),
          hasReusableSearch: !!document.querySelector('.reusable-search__result-container'),
          hasEntityResult: !!document.querySelector('.entity-result__item'),
          allLinks: document.querySelectorAll('a[href*="/in/"]').length,
          bodyText: document.body.innerText.substring(0, 200)
        }));
        console.log('Diagnóstico:', JSON.stringify(diagnostic, null, 2));
      }

      // Los perfiles ya vienen filtrados (exclusiones aplicadas durante la recolección).
      // Este segundo filtro es solo red de seguridad por si algún perfil llegó sin URL para comparar.
      let filteredProfiles = profiles;
      if (exclusionUrls && exclusionUrls.length > 0 && filteredProfiles.length > 0) {
        const beforeExclusion = filteredProfiles.length;
        filteredProfiles = filteredProfiles.filter(profile => !shouldExcludeProfile(profile, exclusionUrls));
        const excludedCount = beforeExclusion - filteredProfiles.length;
        if (excludedCount > 0) {
          console.log(`  [red de seguridad] ${excludedCount} perfiles adicionales excluidos en segunda pasada`);
        }
      }

      // Limitar resultados
      console.log(`[DEBUG searchPerson] maxResults=${maxResults}, filteredProfiles.length=${filteredProfiles.length}`);
      if (maxResults && filteredProfiles.length > maxResults) {
        console.log(`[DEBUG searchPerson] Aplicando límite: de ${filteredProfiles.length} a ${maxResults}`);
        filteredProfiles = filteredProfiles.slice(0, maxResults);
      }

      // Obtener detalles completos si se solicita
      if (getFullDetails && filteredProfiles.length > 0) {
        console.log(`  Obteniendo detalles completos de ${filteredProfiles.length} perfiles...`);
        for (let i = 0; i < filteredProfiles.length; i++) {
          const profile = filteredProfiles[i];
          if (profile.urlPerfil && profile.urlPerfil !== 'N/A') {
            try {
              console.log(`    [${i + 1}/${filteredProfiles.length}] ${profile.nombre}`);
              const details = await this.getProfileDetails(profile.urlPerfil);
              if (details) {
                profile.detallesCompletos = details;
                if (details.nombreCompleto && details.nombreCompleto !== 'N/A') profile.nombre = details.nombreCompleto;
                if (details.headline && details.headline !== 'N/A') profile.titulo = details.headline;
                if (details.ubicacion && details.ubicacion !== 'N/A') profile.ubicacion = details.ubicacion;
              }
              // Delay entre perfiles para evitar ser bloqueado
              if (i < filteredProfiles.length - 1) {
                await this.page.waitForTimeout(2000);
              }
            } catch (error) {
              console.log(`    ⚠ Error obteniendo detalles: ${error.message}`);
            }
          }
        }
      }

      return filteredProfiles;
    } catch (error) {
      console.error('Error durante la búsqueda:', error.message);
      return [];
    }
  }

  // Extrae los perfiles visibles en la página actual de búsqueda (reutilizable para paginación)
  async _extractProfilesFromCurrentPage() {
    return this.page.evaluate(() => {
      const results = [];
      const selectors = [
        'div[data-view-name="people-search-result"]',
        'div.dea36951[data-view-name="people-search-result"]',
        'li.entity-result__item',
        '.entity-result__item',
        'li.reusable-search__result-container',
        '.reusable-search__result-container',
        'li[class*="result"]',
        'div[class*="entity-result"]',
        '[class*="search-result"]',
        'li[data-chameleon-result-urn]',
        'div[data-chameleon-result-urn]'
      ];
      let profileCards = [];
      for (const selector of selectors) {
        const foundCards = document.querySelectorAll(selector);
        if (foundCards.length > 0) {
          profileCards = Array.from(foundCards);
          break;
        }
      }
      if (profileCards.length === 0) {
        const allLinks = document.querySelectorAll('a[href*="/in/"]');
        const cardsFromLinks = [];
        allLinks.forEach((link) => {
          if (link.href && link.href.includes('/in/') && !link.href.includes('/in/feed') && !link.href.includes('/in/recruiter')) {
            const card = link.closest('li') || link.closest('div') || link.parentElement;
            if (card && !cardsFromLinks.includes(card)) cardsFromLinks.push(card);
          }
        });
        profileCards = cardsFromLinks;
      }
      if (!Array.isArray(profileCards)) profileCards = Array.from(profileCards);
      profileCards.forEach((card, index) => {
        try {
          // Evitar tomar "Ofrece servicios: ..." como nombre: preferir enlace con aria-label "Ver perfil de" o texto que no sea la sección de servicios
          const isServicesText = (text) => {
            if (!text || typeof text !== 'string') return false;
            const t = text.trim().toLowerCase();
            return t.startsWith('ofrece servicios') || t.startsWith('services') || (t.includes('ofrece servicios') && t.length > 40) || (t.split(',').length >= 3 && t.length > 50);
          };
          const nameSelectors = ['a[data-view-name="search-result-lockup-title"]', '.entity-result__title-text a', 'a[href*="/in/"][aria-label]', 'a[href*="/in/"]'];
          let nameElement = null;
          for (const sel of nameSelectors) {
            const candidates = card.querySelectorAll(sel);
            for (const el of candidates) {
              const text = (el.innerText || '').trim();
              const ariaLabel = (el.getAttribute('aria-label') || '').trim();
              if (ariaLabel && /^Ver perfil de\s+/i.test(ariaLabel)) {
                nameElement = el;
                break;
              }
              if (text.length > 0 && !isServicesText(text)) {
                nameElement = el;
                break;
              }
            }
            if (nameElement) break;
          }
          if (!nameElement) {
            const profileLink = card.querySelector('a[href*="/in/"]:not([href*="/in/feed"])');
            if (profileLink) nameElement = profileLink;
          }
          let name = nameElement && nameElement.innerText ? nameElement.innerText.trim() : 'N/A';
          const profileUrl = nameElement && nameElement.href ? nameElement.href.split('?')[0] : 'N/A';
          if (isServicesText(name)) name = 'N/A';
          if (name === 'N/A' && profileUrl !== 'N/A' && nameElement) {
            const ariaLabel = nameElement.getAttribute('aria-label');
            if (ariaLabel) {
              const nameFromAria = ariaLabel.replace(/^Ver perfil de\s*/i, '').trim();
              if (nameFromAria.length > 0) name = nameFromAria;
            }
          }
          const titleSelectors = ['.entity-result__primary-subtitle', '[class*="subtitle"]'];
          let titleElement = null;
          for (const sel of titleSelectors) {
            titleElement = card.querySelector(sel);
            if (titleElement && titleElement.innerText) {
              const text = titleElement.innerText.trim().toLowerCase();
              if (!text.match(/^(perú|peru|lima|madrid|españa|spain|área metropolitana|metropolitan area)/i)) break;
            }
          }
          const title = titleElement ? titleElement.innerText.trim() : 'N/A';
          const locationSelectors = ['.entity-result__secondary-subtitle', '[class*="location"]', '[class*="secondary"]'];
          let locationElement = null;
          for (const sel of locationSelectors) {
            locationElement = card.querySelector(sel);
            if (locationElement && locationElement.innerText && locationElement.innerText.trim().length > 0) break;
          }
          const location = locationElement ? locationElement.innerText.trim() : 'N/A';
          const descSelectors = ['.entity-result__summary', '[class*="summary"]'];
          let descriptionElement = null;
          for (const sel of descSelectors) {
            descriptionElement = card.querySelector(sel);
            if (descriptionElement) break;
          }
          const description = descriptionElement ? descriptionElement.innerText.trim() : 'N/A';
          const imageSelectors = ['.entity-result__universal-image img', 'figure img', 'img[alt*="profile"]'];
          let imageElement = null;
          for (const sel of imageSelectors) {
            imageElement = card.querySelector(sel);
            if (imageElement) break;
          }
          const imageUrl = imageElement ? imageElement.src : 'N/A';
          if ((name !== 'N/A' && name.length > 0) || (profileUrl !== 'N/A' && profileUrl.includes('/in/'))) {
            results.push({ nombre: name, titulo: title, ubicacion: location, descripcion: description, urlPerfil: profileUrl, imagenPerfil: imageUrl });
          }
        } catch (err) {}
      });
      return results;
    });
  }

  // Filtrar perfiles por palabras clave en la descripción, título o nombre
  filterProfilesByKeywords(profiles, keywords) {
    if (!keywords || keywords.length === 0) {
      return profiles;
    }

    // Normalizar palabras clave a minúsculas
    const normalizedKeywords = keywords.map(k => k.toLowerCase().trim());
    
    return profiles.filter(profile => {
      // Buscar en descripción, título, nombre y ubicación
      const searchText = [
        profile.descripcion || '',
        profile.titulo || '',
        profile.nombre || '',
        profile.ubicacion || ''
      ].join(' ').toLowerCase();

      // Verificar si alguna palabra clave está presente
      return normalizedKeywords.some(keyword => {
        return searchText.includes(keyword);
      });
    });
  }

  // Ordenar perfiles poniendo primero los que coinciden con las palabras clave (prioridad de barrido, no exclusión)
  prioritizeProfilesByKeywords(profiles, keywords) {
    if (!keywords || keywords.length === 0) {
      return profiles;
    }
    const matching = this.filterProfilesByKeywords(profiles, keywords);
    const matchingUrls = new Set(matching.map(p => (p.urlPerfil || '').trim()).filter(Boolean));
    const rest = profiles.filter(p => !matchingUrls.has((p.urlPerfil || '').trim()));
    return [...matching, ...rest];
  }

  async getProfileDetails(profileUrl) {
    try {
      console.log(`Obteniendo detalles del perfil: ${profileUrl}`);
      await this.page.goto(profileUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });

      await this.page.waitForTimeout(3000);

      // Captura de la página del perfil con nombre legible extraído del slug de la URL
      const profileSlug = (profileUrl.match(/\/in\/([\w-]+)/) || [])[1] || 'perfil';
      await this.takeDebugScreenshot(`04_perfil_${profileSlug}`);

      // Verificar que estamos en la página correcta
      const currentUrl = this.page.url();
      console.log(`  URL del perfil: ${currentUrl}`);

      // Hacer scroll para cargar todo el contenido
      console.log('  Cargando contenido completo del perfil...');
      await this.page.evaluate(async () => {
        await new Promise((resolve) => {
          let totalHeight = 0;
          const distance = 200;
          let lastHeight = document.body.scrollHeight;
          const timer = setInterval(() => {
            window.scrollBy(0, distance);
            totalHeight += distance;
            const currentHeight = document.body.scrollHeight;

            // Si la altura no cambia después de varios scrolls, terminamos
            if (currentHeight === lastHeight && totalHeight > 1000) {
              clearInterval(timer);
              resolve();
            } else {
              lastHeight = currentHeight;
            }

            // Límite de seguridad
            if (totalHeight > 10000) {
              clearInterval(timer);
              resolve();
            }
          }, 150);
        });
      });
      await this.page.waitForTimeout(3000);

      // Hacer clic en "Ver más" si existe para expandir secciones, especialmente experiencia
      console.log('  Expandiendo secciones "Ver más"...');
      try {
        // Buscar y expandir la sección de experiencia primero
        const experienceSection = await this.page.$('section[data-section="experience"], #experience-section, [id*="experience"]');
        if (experienceSection) {
          console.log('  Sección de experiencia encontrada, expandiendo...');
          // Buscar botones "Ver más" dentro de la sección de experiencia
          const seeMoreInExp = await this.page.evaluate((section) => {
            const buttons = section.querySelectorAll('button[aria-label*="Ver más"], button[aria-label*="See more"], button[aria-label*="Show more"], span[aria-label*="Ver más"], span[aria-label*="See more"]');
            return Array.from(buttons).map(btn => {
              try {
                btn.click();
                return true;
              } catch (e) {
                return false;
              }
            });
          }, experienceSection);
          await this.page.waitForTimeout(2000);
        }
        
        // Buscar y hacer clic en todos los botones "Ver más" de la página
        const seeMoreButtons = await this.page.evaluate(() => {
          // Selectores válidos de CSS (sin :has-text que no es CSS estándar)
          const buttonSelectors = [
            'button[aria-label*="Ver más"]',
            'button[aria-label*="See more"]',
            'button[aria-label*="Show more"]',
            'span[aria-label*="Ver más"]',
            'span[aria-label*="See more"]',
            'button span:contains("Ver más")',
            'button span:contains("See more")'
          ];
          
          let allButtons = [];
          buttonSelectors.forEach(selector => {
            try {
              const buttons = document.querySelectorAll(selector);
              allButtons = allButtons.concat(Array.from(buttons));
            } catch (e) {
              // Ignorar selectores inválidos
            }
          });
          
          // También buscar botones por texto interno
          const allButtonsOnPage = document.querySelectorAll('button, span[role="button"]');
          allButtonsOnPage.forEach(btn => {
            const text = btn.innerText || btn.textContent || '';
            if (text.includes('Ver más') || text.includes('See more') || text.includes('Show more')) {
              if (!allButtons.includes(btn)) {
                allButtons.push(btn);
              }
            }
          });
          
          let clicked = 0;
          allButtons.forEach(btn => {
            try {
              if (btn.offsetParent !== null) { // Verificar que el botón sea visible
                btn.click();
                clicked++;
              }
            } catch (e) {
              // Ignorar errores
            }
          });
          return clicked;
        });
        
        if (seeMoreButtons > 0) {
          console.log(`  Expandidos ${seeMoreButtons} elementos "Ver más"`);
        }
        
        await this.page.waitForTimeout(2000);
        
        // Hacer scroll específicamente a la sección de experiencia y expandir todas las experiencias
        await this.page.evaluate(() => {
          const expSection = document.querySelector('section[data-section="experience"], #experience-section');
          if (expSection) {
            expSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            
            // Buscar y hacer clic en "Ver más experiencias" si existe
            const showMoreExp = expSection.querySelector('button[aria-label*="Ver más"], button[aria-label*="See more"], button[aria-label*="Show more"]');
            if (showMoreExp) {
              try {
                showMoreExp.click();
              } catch (e) {}
            }
          }
        });
        await this.page.waitForTimeout(3000);
        
        // Hacer scroll dentro de la sección de experiencia para cargar todos los items
        console.log('  Haciendo scroll dentro de la sección de experiencia...');
        await this.page.evaluate(() => {
          const expSection = document.querySelector('section[data-section="experience"], #experience-section');
          if (expSection) {
            let lastHeight = expSection.scrollHeight;
            let scrollAttempts = 0;
            const maxScrolls = 10;
            
            const scrollInterval = setInterval(() => {
              // Scroll dentro de la sección
              expSection.scrollTop += 500;
              scrollAttempts++;
              
              // También hacer scroll de la página hacia abajo
              window.scrollBy(0, 300);
              
              const currentHeight = expSection.scrollHeight;
              
              // Si no hay más contenido o alcanzamos el máximo, detener
              if (currentHeight === lastHeight && scrollAttempts > 3 || scrollAttempts >= maxScrolls) {
                clearInterval(scrollInterval);
              } else {
                lastHeight = currentHeight;
              }
            }, 500);
            
            // Detener después de 5 segundos
            setTimeout(() => clearInterval(scrollInterval), 5000);
          }
        });
        await this.page.waitForTimeout(3000);
        
        // Intentar hacer clic en "Ver más" dentro de la sección de experiencia varias veces
        for (let i = 0; i < 3; i++) {
          await this.page.evaluate(() => {
            const expSection = document.querySelector('section[id="experience"], section[data-section="experience"], #experience-section');
            if (expSection) {
              const seeMoreButtons = expSection.querySelectorAll('button[aria-label*="Ver más"], button[aria-label*="See more"], button[aria-label*="Show more"], span[aria-label*="Ver más"], button.inline-show-more-text__button');
              seeMoreButtons.forEach(btn => {
                try {
                  if (btn.offsetParent !== null) {
                    btn.click();
                  }
                } catch (e) {}
              });
            }
          });
          await this.page.waitForTimeout(1500);
        }
        
        // Buscar y hacer clic en "Mostrar todas las experiencias" si existe
        console.log('  Buscando botón "Mostrar todas las experiencias"...');
        try {
          // Buscar el botón por ID o por texto
          const showAllButton = await this.page.evaluate(() => {
            // Buscar por ID
            let button = document.querySelector('a[id="navigation-index-see-all-experiences"]');
            if (button) return { found: true, href: button.href };
            
            // Buscar por href que contenga /details/experience
            button = document.querySelector('a[href*="/details/experience"]');
            if (button) return { found: true, href: button.href };
            
            // Buscar por texto
            const allLinks = document.querySelectorAll('a');
            for (const link of allLinks) {
              const text = link.innerText || link.textContent || '';
              if (text.includes('Mostrar todas las experiencias') || 
                  text.includes('Show all experiences') ||
                  (text.includes('experiencias') && text.match(/\d+/))) {
                return { found: true, href: link.href };
              }
            }
            return { found: false };
          });
          
          if (showAllButton.found) {
            console.log(`  Encontrado botón "Mostrar todas las experiencias", navegando a: ${showAllButton.href}`);
            await this.page.goto(showAllButton.href, {
              waitUntil: 'domcontentloaded',
              timeout: 30000
            });
            await this.page.waitForTimeout(3000);
            
            // Hacer scroll en la nueva página para cargar todo
            await this.page.evaluate(async () => {
              await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 200;
                let lastHeight = document.body.scrollHeight;
                const timer = setInterval(() => {
                  window.scrollBy(0, distance);
                  totalHeight += distance;
                  const currentHeight = document.body.scrollHeight;
                  
                  if (currentHeight === lastHeight && totalHeight > 1000) {
                    clearInterval(timer);
                    resolve();
                  } else {
                    lastHeight = currentHeight;
                  }
                  
                  if (totalHeight > 10000) {
                    clearInterval(timer);
                    resolve();
                  }
                }, 150);
              });
            });
            await this.page.waitForTimeout(2000);
            
            // Expandir todas las descripciones en la página de todas las experiencias
            const clickedCount = await this.page.evaluate(() => {
              const seeMoreButtons = document.querySelectorAll('button.inline-show-more-text__button, button[aria-label*="Ver más"], button[aria-label*="See more"]');
              let clicked = 0;
              seeMoreButtons.forEach(btn => {
                try {
                  if (btn.offsetParent !== null) {
                    btn.click();
                    clicked++;
                  }
                } catch (e) {}
              });
              // También buscar botones por texto
              const allButtons = document.querySelectorAll('button');
              allButtons.forEach(btn => {
                const text = btn.innerText || btn.textContent || '';
                if ((text.includes('ver más') || text.includes('See more')) && btn.offsetParent !== null) {
                  try {
                    btn.click();
                    clicked++;
                  } catch (e) {}
                }
              });
              return clicked;
            });
            console.log(`  Expandidas ${clickedCount} descripciones`);
            await this.page.waitForTimeout(2000);
          } else {
            console.log('  No se encontró botón "Mostrar todas las experiencias"');
          }
        } catch (e) {
          console.log('  Error buscando botón "Mostrar todas las experiencias":', e.message);
        }
        
      } catch (e) {
        console.log('  Error expandiendo secciones:', e.message);
      }
      
      await this.page.waitForTimeout(2000);

      // Intentar obtener información de contacto desde el modal
      console.log('  Intentando obtener información de contacto...');
      let contactInfo = { email: 'N/A', telefono: 'N/A', sitioWeb: 'N/A' };
      try {
        // Construir la URL del modal de contacto
        const profileSlug = profileUrl.match(/\/in\/([^\/]+)/)?.[1];
        if (profileSlug) {
          const contactModalUrl = `https://www.linkedin.com/in/${profileSlug}/overlay/contact-info/`;
          console.log(`  Navegando a modal de contacto: ${contactModalUrl}`);
          
          // Navegar al modal de contacto
          await this.page.goto(contactModalUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
          });
          await this.page.waitForTimeout(3000);
          
          // Esperar a que aparezca el modal
          try {
            await this.page.waitForSelector('.artdeco-modal, [data-test-modal]', { timeout: 10000 });
            console.log('  Modal de contacto encontrado');
            
            // Extraer información de contacto del modal
            contactInfo = await this.page.evaluate(() => {
              const info = { email: 'N/A', telefono: 'N/A', sitioWeb: 'N/A' };
              
              // Buscar la sección "Enviar email" o "Send email" específicamente
              // Esta sección contiene el email del perfil objetivo, no el de la cuenta logueada
              const emailSectionHeaders = document.querySelectorAll('h3.pv-contact-info__header, h3[class*="pv-contact-info__header"]');
              let emailSection = null;
              
              for (const header of emailSectionHeaders) {
                const headerText = header.innerText || header.textContent || '';
                if (headerText.includes('Enviar email') || headerText.includes('Send email') || headerText.includes('Email')) {
                  // Encontrar la sección padre que contiene este header
                  emailSection = header.closest('section.pv-contact-info__contact-type') || 
                                header.closest('section') ||
                                header.parentElement;
                  break;
                }
              }
              
              // Si encontramos la sección de email, buscar el enlace mailto: dentro de ella
              if (emailSection) {
                const emailLink = emailSection.querySelector('a[href^="mailto:"]');
                if (emailLink) {
                  const emailHref = emailLink.getAttribute('href');
                  const emailMatch = emailHref.match(/mailto:(.+)/i);
                  if (emailMatch) {
                    info.email = emailMatch[1].trim();
                  } else {
                    // Si no hay match, usar el texto del enlace
                    info.email = emailLink.innerText.trim();
                  }
                }
              }
              
              // Si no encontramos en la sección específica, buscar todos los mailto: pero filtrar
              // para evitar el email de la cuenta logueada (que suele estar en "Tu perfil")
              if (info.email === 'N/A') {
                const allEmailLinks = document.querySelectorAll('a[href^="mailto:"]');
                for (const emailLink of allEmailLinks) {
                  // Verificar que NO esté en la sección "Tu perfil" o "Your profile"
                  const parentSection = emailLink.closest('section.pv-contact-info__contact-type') || 
                                       emailLink.closest('section');
                  if (parentSection) {
                    const sectionText = parentSection.innerText || '';
                    // Si NO contiene "Tu perfil" o "Your profile", es probablemente el email del perfil objetivo
                    if (!sectionText.includes('Tu perfil') && !sectionText.includes('Your profile') && 
                        !sectionText.includes('linkedin.com/in/')) {
                      const emailHref = emailLink.getAttribute('href');
                      const emailMatch = emailHref.match(/mailto:(.+)/i);
                      if (emailMatch) {
                        info.email = emailMatch[1].trim();
                        break;
                      }
                    }
                  }
                }
              }
              
              // Buscar teléfono en enlaces tel:
              const phoneLinks = document.querySelectorAll('a[href^="tel:"]');
              if (phoneLinks.length > 0) {
                const phoneHref = phoneLinks[0].getAttribute('href');
                const phoneMatch = phoneHref.match(/tel:(.+)/i);
                if (phoneMatch) {
                  info.telefono = phoneMatch[1].trim();
                } else {
                  info.telefono = phoneLinks[0].innerText.trim();
                }
              }
              
              // Buscar sitio web (enlaces http/https que no sean de LinkedIn)
              const websiteLinks = document.querySelectorAll('a[href^="http"]:not([href*="linkedin.com"])');
              if (websiteLinks.length > 0) {
                info.sitioWeb = websiteLinks[0].href;
              }
              
              // También buscar en el texto del modal
              const modalText = document.body.innerText || '';
              
              // Buscar email en el texto si no lo encontramos en enlaces
              if (info.email === 'N/A') {
                const emailPattern = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/;
                const emailMatch = modalText.match(emailPattern);
                if (emailMatch) {
                  info.email = emailMatch[1];
                }
              }
              
              // Buscar teléfono en el texto si no lo encontramos en enlaces
              if (info.telefono === 'N/A') {
                const phonePattern = /(\+?\d{1,3}[\s-]?)?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/;
                const phoneMatch = modalText.match(phonePattern);
                if (phoneMatch) {
                  info.telefono = phoneMatch[0];
                }
              }
              
              return info;
            });
            
            console.log(`  Información de contacto extraída: email=${contactInfo.email}, teléfono=${contactInfo.telefono}, sitio=${contactInfo.sitioWeb}`);
            
            // Volver a la página del perfil
            await this.page.goto(profileUrl, {
              waitUntil: 'domcontentloaded',
              timeout: 30000
            });
            await this.page.waitForTimeout(2000);
          } catch (modalError) {
            console.log('  No se pudo abrir el modal de contacto o no está disponible');
            // Volver a la página del perfil si falla
            await this.page.goto(profileUrl, {
              waitUntil: 'domcontentloaded',
              timeout: 30000
            });
            await this.page.waitForTimeout(2000);
          }
        }
      } catch (contactError) {
        console.log(`  Error obteniendo información de contacto: ${contactError.message}`);
        // Asegurarse de estar en la página del perfil
        try {
          await this.page.goto(profileUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
          });
          await this.page.waitForTimeout(2000);
        } catch (e) {
          // Ignorar errores de navegación
        }
      }

      // Extraer el nombre del perfil ANTES de navegar a la página de detalles
      const profileName = await this.page.evaluate(() => {
        const nameSelectors = [
          'h1.text-heading-xlarge',
          'h1[class*="text-heading-xlarge"]',
          '.pv-text-details__left-panel h1',
          'main h1',
          '.ph5 h1',
          'h1'
        ];
        for (const selector of nameSelectors) {
          const element = document.querySelector(selector);
          if (element && element.innerText && element.innerText.trim()) {
            return element.innerText.trim();
          }
        }
        return null;
      });
      
      console.log(`  Nombre del perfil extraído: ${profileName || 'No encontrado'}`);

      // Experiencia laboral desde la ruta /details/experience/ (estructura oficial de LinkedIn)
      let experienceFromDetailsPage = [];
      try {
        const baseProfileUrl = profileUrl.replace(/\?.*$/, '').replace(/\/$/, '');
        const experienceDetailsUrl = `${baseProfileUrl}/details/experience/`;
        console.log(`  Obteniendo experiencia desde: ${experienceDetailsUrl}`);
        await this.page.goto(experienceDetailsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await this.page.waitForTimeout(3000);
        // Esperar lista de experiencias (DOM de la página details/experience)
        await this.page.waitForSelector('li.pvs-list__paged-list-item, div[data-view-name="profile-component-entity"]', { timeout: 10000 }).catch(() => null);
        await this.page.waitForTimeout(1500);
        // Scroll para cargar todas las experiencias
        await this.page.evaluate(() => {
          const content = document.querySelector('.scaffold-finite-scroll__content');
          if (content) {
            let h = 0;
            const iv = setInterval(() => {
              window.scrollBy(0, 300);
              h += 300;
              if (h > 5000) clearInterval(iv);
            }, 200);
            setTimeout(() => clearInterval(iv), 4000);
          }
        });
        await this.page.waitForTimeout(2000);
        experienceFromDetailsPage = await this.page.evaluate(() => {
          const results = [];
          const items = document.querySelectorAll('li.pvs-list__paged-list-item');
          items.forEach((li) => {
            const entity = li.querySelector('div[data-view-name="profile-component-entity"]') || li;
            const getText = (sel, def = 'N/A') => {
              const el = entity.querySelector(sel);
              return el && el.innerText && el.innerText.trim() ? el.innerText.trim() : def;
            };
            const puesto = getText('.mr1.hoverable-link-text.t-bold span[aria-hidden="true"]') || getText('.t-bold span[aria-hidden="true"]') || getText('.hoverable-link-text.t-bold span[aria-hidden="true"]');
            const captionEl = entity.querySelector('.pvs-entity__caption-wrapper');
            const periodo = captionEl && captionEl.innerText ? captionEl.innerText.trim() : 'N/A';
            const companyEl = entity.querySelector('span.t-14.t-normal:not(.t-black--light) span[aria-hidden="true"]');
            let empresa = 'N/A';
            if (companyEl && companyEl.innerText) {
              empresa = companyEl.innerText.trim();
              if (empresa.includes('·')) empresa = empresa.split('·')[0].trim();
              if (empresa.length > 150) empresa = empresa.substring(0, 150);
            }
            const blackLightSpans = entity.querySelectorAll('span.t-14.t-normal.t-black--light span[aria-hidden="true"], span.t-14.t-normal.t-black--light');
            let ubicacion = 'N/A';
            for (const sp of blackLightSpans) {
              const t = (sp.innerText || sp.textContent || '').trim();
              if (t && !t.match(/\d{4}|años|meses|actualidad|actual|present/i) && t.length < 150) {
                ubicacion = t;
                break;
              }
            }
            const subComp = entity.querySelector('.pvs-entity__sub-components');
            let descripcion = 'N/A';
            if (subComp) {
              const descEl = subComp.querySelector('.t-14.t-normal.t-black span[aria-hidden="true"], .t-14.t-normal.t-black, [class*="t-normal"][class*="t-black"] span[aria-hidden="true"]');
              if (descEl && descEl.innerText && descEl.innerText.trim().length > 10) descripcion = descEl.innerText.trim();
            }
            if (puesto && puesto !== 'N/A') {
              results.push({ puesto, empresa, periodo, ubicacion, descripcion, duracion: 'N/A', tipoEmpleo: 'N/A' });
            }
          });
          return results;
        });
        console.log(`  Experiencia extraída desde details/experience: ${experienceFromDetailsPage.length} entradas`);
        await this.page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await this.page.waitForTimeout(2000);
      } catch (expErr) {
        console.log(`  No se pudo obtener experiencia desde details/experience: ${expErr.message}`);
        try {
          await this.page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await this.page.waitForTimeout(1500);
        } catch (e) {}
      }

      const profileData = await this.page.evaluate((savedName, contactInfoFromModal) => {
        const data = {};
        
        // Función auxiliar para extraer texto con múltiples selectores
        const getText = (selectors, defaultText = 'N/A') => {
          if (typeof selectors === 'string') selectors = [selectors];
          for (const selector of selectors) {
            const element = document.querySelector(selector);
            if (element && element.innerText && element.innerText.trim()) {
              return element.innerText.trim();
            }
          }
          return defaultText;
        };

        const getAllText = (selectors, defaultText = 'N/A') => {
          if (typeof selectors === 'string') selectors = [selectors];
          for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            if (elements.length > 0) {
              return Array.from(elements).map(el => el.innerText.trim()).filter(t => t).join(' ');
            }
          }
          return defaultText;
        };
        
        // Nombre completo - usar el nombre guardado o buscar en la página actual
        if (savedName) {
          data.nombreCompleto = savedName;
        } else {
          // Buscar en la página actual (puede ser la página de detalles)
          data.nombreCompleto = getText([
            'h1.text-heading-xlarge',
            'h1[class*="text-heading-xlarge"]',
            '.pv-text-details__left-panel h1',
            'main h1',
            '.ph5 h1',
            'h1',
            // En la página de detalles, buscar en breadcrumb o header
            '.global-nav__me-photo',
            'nav a[href*="/in/"]',
            '.artdeco-breadcrumbs a[href*="/in/"]'
          ]);
          
          // Si aún no encontramos, intentar extraer de la URL
          if (data.nombreCompleto === 'N/A') {
            const urlMatch = window.location.href.match(/\/in\/([^\/]+)/);
            if (urlMatch) {
              // Convertir slug a nombre (aproximado)
              const slug = urlMatch[1];
              data.nombreCompleto = slug.split('-').map(word => 
                word.charAt(0).toUpperCase() + word.slice(1)
              ).join(' ');
            }
          }
        }
        
        // Título/Headline - múltiples selectores
        data.headline = getText([
          '.text-body-medium.break-words',
          '.pv-text-details__left-panel .text-body-medium',
          '[class*="headline"]',
          '.pv-top-card__headline',
          '.text-body-medium'
        ]);
        
        // Ubicación - múltiples selectores
        data.ubicacion = getText([
          '.text-body-small.inline.t-black--light.break-words',
          '.pv-text-details__left-panel .text-body-small',
          '[class*="location"]',
          '.pv-top-card__location',
          '.text-body-small'
        ]);
        
        // Información de contacto - usar la información del modal si está disponible
        data.contacto = {
          email: contactInfoFromModal?.email || 'N/A',
          telefono: contactInfoFromModal?.telefono || 'N/A',
          sitioWeb: contactInfoFromModal?.sitioWeb || 'N/A'
        };
        
        // Si no obtuvimos información del modal, intentar buscar en la página
        if (data.contacto.email === 'N/A' || data.contacto.telefono === 'N/A' || data.contacto.sitioWeb === 'N/A') {
          const contactSection = document.querySelector('#top-card-text-details-contact-info, [id*="contact"]');
          if (contactSection) {
            const contactText = contactSection.innerText;
            
            // Intentar extraer email si no lo tenemos
            if (data.contacto.email === 'N/A') {
              const emailMatch = contactText.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/);
              if (emailMatch) {
                data.contacto.email = emailMatch[1];
              }
            }
            
            // Intentar extraer teléfono si no lo tenemos
            if (data.contacto.telefono === 'N/A') {
              const phoneMatch = contactText.match(/(\+?\d{1,3}[\s-]?)?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/);
              if (phoneMatch) {
                data.contacto.telefono = phoneMatch[0];
              }
            }
            
            // Sitio web si no lo tenemos
            if (data.contacto.sitioWeb === 'N/A') {
              const websiteLink = contactSection.querySelector('a[href^="http"]:not([href*="linkedin.com"])');
              if (websiteLink) {
                data.contacto.sitioWeb = websiteLink.href;
              }
            }
          }
        }
        
        // Acerca de (descripción completa) - buscar en múltiples lugares
        const aboutSelectors = [
          '#about ~ .display-flex .inline-show-more-text',
          '#about ~ .pvs-list .inline-show-more-text',
          '[id="about"] + * .inline-show-more-text',
          '[data-section="summary"] .inline-show-more-text',
          'section[data-section="summary"] .inline-show-more-text',
          'section[data-section="summary"] .pv-shared-text-with-see-more',
          '#about-section .inline-show-more-text',
          '#about-section .pv-shared-text-with-see-more',
          '[id*="about"] .inline-show-more-text',
          '[id*="about"] .pv-shared-text-with-see-more'
        ];
        data.acercaDe = 'N/A';
        for (const selector of aboutSelectors) {
          const aboutElement = document.querySelector(selector);
          if (aboutElement && aboutElement.innerText && aboutElement.innerText.trim()) {
            data.acercaDe = aboutElement.innerText.trim();
            break;
          }
        }
        
        // Si no encontramos "Acerca de", buscar cualquier texto descriptivo en la sección
        if (data.acercaDe === 'N/A') {
          const aboutSection = document.querySelector('section[data-section="summary"], #about-section, [id*="about"]');
          if (aboutSection) {
            const aboutText = aboutSection.innerText.trim();
            if (aboutText && aboutText.length > 20) {
              data.acercaDe = aboutText;
            }
          }
        }
        
        // Experiencia laboral detallada - usando la estructura real de LinkedIn
        console.log('Buscando sección de experiencia...');
        
        // Verificar si estamos en la página de detalles de experiencia
        const isExperienceDetailsPage = window.location.href.includes('/details/experience');
        console.log(`¿Estamos en página de detalles de experiencia? ${isExperienceDetailsPage}`);
        
        const experienceSelectors = [
          'section[id="experience"]',
          'section.artdeco-card[id="experience"]',
          'section[data-section="experience"]',
          '#experience',
          '#experience-section',
          'section.pv-profile-card[id*="experience"]'
        ];
        
        let experienceSection = null;
        for (const selector of experienceSelectors) {
          experienceSection = document.querySelector(selector);
          if (experienceSection) {
            console.log(`Sección de experiencia encontrada con selector: ${selector}`);
            break;
          }
        }
        
        // Si estamos en la página de detalles y no encontramos la sección, buscar en main
        if (!experienceSection && isExperienceDetailsPage) {
          // En la página de detalles, las experiencias están directamente en main
          experienceSection = document.querySelector('main, .core-rail, [role="main"]');
          if (!experienceSection) {
            // Si no encontramos main, usar el body
            experienceSection = document.body;
          }
          console.log('Buscando en página de detalles de experiencia (main/core-rail/body)...');
        }
        
        data.experiencia = [];
        
        // Si encontramos la sección, buscar items de experiencia
        if (experienceSection) {
          console.log('Buscando items de experiencia dentro de la sección...');
          // Selectores basados en la estructura real de LinkedIn que me mostró el usuario
          const itemSelectors = [
            'li.artdeco-list__item.dTqCywpNrCuwxIaRAdkDqHdyscpXWllOOZVs',
            'li[class*="artdeco-list__item"][class*="dTqCywpNrCuwxIaRAdkDqHdyscpXWllOOZVs"]',
            'li.artdeco-list__item',
            'li[class*="artdeco-list__item"]',
            'div[data-view-name="profile-component-entity"]',
            '.pvs-list__paged-list-item',
            'li.pvs-list__paged-list-item',
            '.pvs-entity'
          ];
          
          let experienceItems = [];
          let bestSelector = '';
          let maxItems = 0;
          
          // Probar todos los selectores y quedarse con el que encuentre más items
          for (const itemSel of itemSelectors) {
            const items = experienceSection.querySelectorAll(itemSel);
            if (items.length > maxItems) {
              maxItems = items.length;
              experienceItems = Array.from(items);
              bestSelector = itemSel;
            }
          }
          
          // Si encontramos items con div, necesitamos obtener el li padre
          if (bestSelector.includes('div[data-view-name') && experienceItems.length > 0) {
            experienceItems = experienceItems.map(div => {
              // Buscar el li padre
              let parent = div.parentElement;
              while (parent && parent.tagName !== 'LI') {
                parent = parent.parentElement;
              }
              return parent || div;
            }).filter(item => item !== null);
          }
          
          if (experienceItems.length > 0) {
            console.log(`Encontrados ${experienceItems.length} items con selector: ${bestSelector}`);
          } else {
            console.log('No se encontraron items en la sección, buscando en toda la página...');
            // Si no encontramos items dentro de la sección, buscar en toda la página
            for (const itemSel of itemSelectors) {
              const items = document.querySelectorAll(itemSel);
              if (items.length > maxItems) {
                maxItems = items.length;
                experienceItems = Array.from(items);
                bestSelector = itemSel;
              }
            }
            if (experienceItems.length > 0) {
              console.log(`Encontrados ${experienceItems.length} items en toda la página con selector: ${bestSelector}`);
            }
          }
          
          // Si aún encontramos pocos items, buscar todos los li que tengan la estructura de experiencia
          if (experienceItems.length <= 1) {
            console.log('Pocos items encontrados, buscando todos los elementos li con estructura de experiencia...');
            const allLis = experienceSection.querySelectorAll('li');
            const validLis = Array.from(allLis).filter(li => {
              // Verificar que tenga un div con data-view-name="profile-component-entity" o un span con puesto
              const hasEntity = li.querySelector('div[data-view-name="profile-component-entity"]');
              const hasTitle = li.querySelector('.t-bold span[aria-hidden="true"], .hoverable-link-text.t-bold, .mr1.hoverable-link-text.t-bold');
              // Verificar que no sea un item de habilidades u otra cosa (debe tener empresa o período)
              const hasCompany = li.querySelector('span.t-14.t-normal span[aria-hidden="true"]');
              const hasPeriod = li.querySelector('.pvs-entity__caption-wrapper, span.t-14.t-normal.t-black--light');
              // En la página de detalles, puede que no tenga empresa visible pero sí período
              return (hasEntity || hasTitle) && (hasCompany || hasPeriod);
            });
            
            if (validLis.length > experienceItems.length) {
              experienceItems = validLis;
              console.log(`Encontrados ${experienceItems.length} elementos li válidos con estructura de experiencia`);
            }
          }
          
          // Si estamos en la página de detalles y aún no encontramos suficientes, buscar en toda la página
          if (experienceItems.length <= 1 && isExperienceDetailsPage) {
            console.log('Buscando experiencias en toda la página de detalles...');
            
            // Buscar todos los li en la página
            const allLisInPage = document.querySelectorAll('li.artdeco-list__item, li[class*="artdeco-list__item"], li');
            console.log(`Total de elementos li encontrados en la página: ${allLisInPage.length}`);
            
            const validExpLis = Array.from(allLisInPage).filter(li => {
              const hasEntity = li.querySelector('div[data-view-name="profile-component-entity"]');
              const hasTitle = li.querySelector('.t-bold span[aria-hidden="true"], .hoverable-link-text.t-bold, .mr1.hoverable-link-text.t-bold, div.t-bold');
              const hasPeriod = li.querySelector('.pvs-entity__caption-wrapper, span.t-14.t-normal.t-black--light, span.pvs-entity__caption-wrapper');
              const hasCompany = li.querySelector('span.t-14.t-normal span[aria-hidden="true"]');
              
              // Debe tener título y (período o empresa) para ser una experiencia válida
              const isValid = hasTitle && (hasPeriod || hasCompany);
              
              if (isValid) {
                // Verificar que no sea un item de habilidades u otra cosa
                const text = li.innerText || '';
                const hasSkillsKeywords = text.match(/(aptitudes|skills|habilidades|Python.*y \d+ aptitudes)/i);
                return !hasSkillsKeywords;
              }
              
              return false;
            });
            
            console.log(`Items válidos encontrados: ${validExpLis.length}`);
            
            if (validExpLis.length > experienceItems.length) {
              experienceItems = validExpLis;
              console.log(`Encontrados ${validExpLis.length} experiencias en toda la página de detalles`);
            }
            
            // Si aún no encontramos suficientes, buscar por estructura de lista ul
            if (experienceItems.length <= 1) {
              console.log('Buscando por estructura de lista ul...');
              const allUls = document.querySelectorAll('ul.UYYUSfQXLYGraQIHlwnWdaGiaLjmZVhpUyM, ul[class*="pvs-list"], ul');
              for (const ul of allUls) {
                const lis = ul.querySelectorAll('li');
                const validLis = Array.from(lis).filter(li => {
                  const hasTitle = li.querySelector('.t-bold, .hoverable-link-text.t-bold, div[class*="t-bold"]');
                  const hasPeriod = li.querySelector('.pvs-entity__caption-wrapper, span[class*="t-black--light"]');
                  return hasTitle && hasPeriod;
                });
                
                if (validLis.length > experienceItems.length) {
                  experienceItems = validLis;
                  console.log(`Encontrados ${validLis.length} experiencias en lista ul`);
                  break;
                }
              }
            }
          }
          
          // Si aún no encontramos, buscar cualquier elemento que contenga texto relacionado con experiencia
          if (experienceItems.length === 0) {
            console.log('Buscando elementos alternativos...');
            const allSections = document.querySelectorAll('section, div[class*="section"]');
            for (const section of allSections) {
              const sectionText = section.innerText.toLowerCase();
              if (sectionText.includes('experience') || sectionText.includes('experiencia') || sectionText.includes('work')) {
                const items = section.querySelectorAll('li, div[class*="item"], div[class*="entity"]');
                if (items.length > 0) {
                  experienceItems = Array.from(items);
                  console.log(`Encontrados ${experienceItems.length} items en sección alternativa`);
                  break;
                }
              }
            }
          }
          
          console.log(`Total de items de experiencia encontrados: ${experienceItems.length}`);
          
          // Log detallado de cada item encontrado para debugging
          if (experienceItems.length > 0) {
            console.log('Items encontrados (primeros 100 caracteres de cada uno):');
            experienceItems.slice(0, 10).forEach((item, idx) => {
              const text = (item.innerText || '').substring(0, 100);
              const hasTitle = item.querySelector('.t-bold, .hoverable-link-text.t-bold');
              const hasPeriod = item.querySelector('.pvs-entity__caption-wrapper');
              console.log(`  Item ${idx + 1}: ${text}... [Título: ${hasTitle ? 'Sí' : 'No'}, Período: ${hasPeriod ? 'Sí' : 'No'}]`);
            });
          }
          
          experienceItems.forEach((item, index) => {
            const exp = {};
            const itemText = item.innerText || '';
            
            // Función auxiliar para buscar dentro del item específico
            const getTextInItem = (selectors, defaultText = 'N/A') => {
              if (typeof selectors === 'string') selectors = [selectors];
              for (const selector of selectors) {
                const element = item.querySelector(selector);
                if (element && element.innerText && element.innerText.trim()) {
                  return element.innerText.trim();
                }
              }
              return defaultText;
            };
            
            // Título del puesto - usando la estructura real de LinkedIn
            const titleSelectors = [
              '.mr1.hoverable-link-text.t-bold span[aria-hidden="true"]',
              '.hoverable-link-text.t-bold span[aria-hidden="true"]',
              '.mr1.t-bold span[aria-hidden="true"]',
              '.t-bold span[aria-hidden="true"]',
              'span[aria-hidden="true"].t-bold',
              'div.t-bold span[aria-hidden="true"]',
              '[class*="title"] span[aria-hidden="true"]',
              'h3 span[aria-hidden="true"]',
              '.pvs-entity__summary-info h3',
              '.pvs-entity__summary-info-v2 h3',
              'h3'
            ];
            
            exp.puesto = getTextInItem(titleSelectors);
            
            // Si no encontramos con selectores, intentar extraer del texto
            if (exp.puesto === 'N/A' && itemText) {
              const lines = itemText.split('\n').filter(l => l.trim());
              if (lines.length > 0) {
                exp.puesto = lines[0].trim();
              }
            }
            
            // Empresa - usando la estructura real de LinkedIn
            // En LinkedIn, la empresa está en: <span class="t-14 t-normal"><span aria-hidden="true">Nombre Empresa · Tipo</span>
            const companySelectors = [
              'span.t-14.t-normal:not(.t-black--light) span[aria-hidden="true"]',
              '.t-14.t-normal span[aria-hidden="true"]:not(.t-black--light)',
              'span.t-14.t-normal span[aria-hidden="true"]',
              '.pvs-entity__summary-info-v2 .t-14.t-normal:not(.t-black--light)',
              '.pvs-entity__summary-info .t-14:not(.t-black--light)'
            ];
            
            exp.empresa = getTextInItem(companySelectors);
            
            // Limpiar la empresa: extraer solo el nombre antes del "·" si existe
            if (exp.empresa !== 'N/A' && exp.empresa.length > 0) {
              // La empresa puede venir como "Nombre Empresa · Jornada completa"
              // Extraer solo la parte antes del "·"
              if (exp.empresa.includes('·')) {
                exp.empresa = exp.empresa.split('·')[0].trim();
              }
              // Si es muy larga, tomar solo hasta el primer punto o salto de línea
              if (exp.empresa.length > 100) {
                exp.empresa = exp.empresa.split('.')[0].split('\n')[0].trim();
              }
            }
            
            // Si aún no encontramos empresa, buscar en el texto estructurado
            if (exp.empresa === 'N/A' && itemText) {
              const lines = itemText.split('\n').filter(l => l.trim() && l.trim().length > 0);
              
              // Buscar la empresa: generalmente está después del puesto y antes del período
              for (let i = 1; i < Math.min(5, lines.length); i++) {
                const line = lines[i].trim();
                
                // Saltar si es una fecha/período
                if (line.match(/\d{4}/) || line.includes('·') && (line.includes('años') || line.includes('mes') || line.includes('Jornada'))) {
                  continue;
                }
                
                // Saltar si parece ser parte de la descripción (muy larga o empieza con guión/punto)
                if (line.length > 150 || line.startsWith('-') || line.startsWith('.')) {
                  continue;
                }
                
                // Si la línea es razonablemente corta, es probablemente la empresa
                if (line.length > 0 && line.length < 100) {
                  // Limpiar si tiene "·"
                  if (line.includes('·')) {
                    exp.empresa = line.split('·')[0].trim();
                  } else {
                    exp.empresa = line;
                  }
                  break;
                }
              }
            }
            
            // Período - usando la estructura real de LinkedIn
            // En LinkedIn está en: <span class="t-14 t-normal t-black--light"><span class="pvs-entity__caption-wrapper" aria-hidden="true">ene. 2024 - actualidad · 2 años 1 mes</span>
            const periodSelectors = [
              '.pvs-entity__caption-wrapper span[aria-hidden="true"]',
              'span.pvs-entity__caption-wrapper[aria-hidden="true"]',
              '.t-14.t-normal.t-black--light .pvs-entity__caption-wrapper',
              '.t-14.t-normal.t-black--light span[aria-hidden="true"]',
              '.t-black--light span[aria-hidden="true"]',
              'span[aria-hidden="true"].t-black--light',
              '[class*="date"] span[aria-hidden="true"]',
              '.pvs-entity__summary-info-v2 .t-14.t-black--light'
            ];
            
            exp.periodo = getTextInItem(periodSelectors);
            
            // Buscar período en el texto (formato común: "ene. 2024 - actualidad · 2 años 1 mes")
            if (exp.periodo === 'N/A' && itemText) {
              const datePattern = /(\d{4}|\w{3}\.?\s+\d{4})\s*[-–—]\s*(\d{4}|\w{3}\.?\s+\d{4}|actualidad|actual|present)/i;
              const dateMatch = itemText.match(datePattern);
              if (dateMatch) {
                exp.periodo = dateMatch[0].trim();
              }
            }
            
            // Ubicación del trabajo - usando la estructura real
            // En LinkedIn está en: <span class="t-14 t-normal t-black--light"><span aria-hidden="true">Лима · En remoto</span>
            const locationSelectors = [
              'span.t-14.t-normal.t-black--light:not(.pvs-entity__caption-wrapper) span[aria-hidden="true"]',
              '.t-14.t-normal.t-black--light span[aria-hidden="true"]:not(.pvs-entity__caption-wrapper)',
              '[class*="location"]',
              '[class*="job-location"]'
            ];
            
            exp.ubicacion = getTextInItem(locationSelectors);
            
            // Limpiar ubicación si tiene "·"
            if (exp.ubicacion !== 'N/A' && exp.ubicacion.includes('·')) {
              exp.ubicacion = exp.ubicacion.split('·').map(p => p.trim()).join(' · ');
            }
            
            // Descripción del trabajo - usando la estructura real de LinkedIn
            // En LinkedIn está en: <div class="VmORUigAzkgzLTGxnkVRVyFoVcxTtFNsgCWW inline-show-more-text...">
            const descSelectors = [
              '.VmORUigAzkgzLTGxnkVRVyFoVcxTtFNsgCWW span[aria-hidden="true"]',
              '.inline-show-more-text span[aria-hidden="true"]',
              '.fCmKBYbtEUhIfaBlxByjDbXNQmZKBwNY .VmORUigAzkgzLTGxnkVRVyFoVcxTtFNsgCWW',
              '.inline-show-more-text',
              '.pv-shared-text-with-see-more',
              '[class*="description"]',
              '.pvs-list__outer-container .inline-show-more-text',
              '.pvs-entity__summary-info-v2 .inline-show-more-text',
              '.pvs-entity__extra-details'
            ];
            
            exp.descripcion = 'N/A';
            for (const descSel of descSelectors) {
              const descElement = item.querySelector(descSel);
              if (descElement) {
                // Intentar obtener el texto del span[aria-hidden="true"] dentro
                const descSpan = descElement.querySelector('span[aria-hidden="true"]');
                const descText = descSpan ? descSpan.innerText.trim() : descElement.innerText.trim();
                
                // Solo usar si es una descripción real (más de 20 caracteres)
                if (descText && descText.length > 20) {
                  // Limpiar el texto: remover saltos de línea múltiples y espacios extra
                  exp.descripcion = descText.replace(/\n{3,}/g, '\n\n').replace(/\s{2,}/g, ' ').trim();
                  break;
                }
              }
            }
            
            // Si no encontramos descripción con selectores, extraer del texto completo
            if (exp.descripcion === 'N/A' && itemText) {
              const lines = itemText.split('\n').filter(l => l.trim() && l.trim().length > 0);
              
              // Buscar la descripción: viene después del puesto, empresa y período
              let startDescIndex = -1;
              
              // Encontrar dónde termina el período (línea con fecha)
              for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                // Si encontramos un período o fecha, la descripción viene después
                if (line.match(/\d{4}/) || line.includes('·') || (line.includes('-') && line.match(/\d/))) {
                  startDescIndex = i + 1;
                  break;
                }
              }
              
              // Si no encontramos período, buscar después de la empresa (si la encontramos)
              if (startDescIndex === -1 && exp.empresa !== 'N/A') {
                for (let i = 0; i < lines.length; i++) {
                  if (lines[i].trim() === exp.empresa || lines[i].trim().includes(exp.empresa.substring(0, 20))) {
                    startDescIndex = i + 1;
                    break;
                  }
                }
              }
              
              // Si aún no encontramos, buscar después del puesto
              if (startDescIndex === -1 && exp.puesto !== 'N/A') {
                for (let i = 0; i < lines.length; i++) {
                  if (lines[i].trim() === exp.puesto || lines[i].trim().includes(exp.puesto.substring(0, 20))) {
                    startDescIndex = i + 1;
                    break;
                  }
                }
              }
              
              if (startDescIndex > 0 && startDescIndex < lines.length) {
                const descLines = lines.slice(startDescIndex);
                // Filtrar líneas que parecen ser parte de la descripción (no son fechas ni muy cortas)
                const validDescLines = descLines.filter(line => {
                  const trimmed = line.trim();
                  // Excluir líneas que son fechas, muy cortas, o que son solo la empresa
                  return trimmed.length > 10 && 
                         !trimmed.match(/^\d{4}/) && 
                         !trimmed.includes('·') &&
                         trimmed !== exp.empresa;
                });
                
                if (validDescLines.length > 0) {
                  const descText = validDescLines.join(' ').trim();
                  // Solo usar si tiene suficiente contenido y no es solo la empresa repetida
                  if (descText.length > 30 && !descText.startsWith(exp.empresa) && descText !== exp.empresa) {
                    exp.descripcion = descText;
                  }
                }
              }
            }
            
            // Si aún no encontramos, buscar párrafos largos en el item
            if (exp.descripcion === 'N/A') {
              const paragraphs = item.querySelectorAll('p, div[class*="text"], li[class*="description"]');
              for (const p of paragraphs) {
                const text = p.innerText.trim();
                // Solo usar si es suficientemente largo y no es el puesto o empresa
                if (text.length > 50 && text !== exp.puesto && !text.includes(exp.empresa)) {
                  exp.descripcion = text;
                  break;
                }
              }
            }
            
            // Duración
            const durationElement = item.querySelector('[class*="duration"]');
            exp.duracion = durationElement ? durationElement.innerText.trim() : 'N/A';
            
            // Tipo de empleo (tiempo completo, parcial, etc.)
            const employmentType = itemText.match(/(Tiempo completo|Tiempo parcial|Contrato|Freelance|Full-time|Part-time|Contract|Freelance|Intern|Pasantía)/i);
            exp.tipoEmpleo = employmentType ? employmentType[1] : 'N/A';
            
            // Solo agregar si tiene al menos puesto o empresa válidos
            if ((exp.puesto !== 'N/A' && exp.puesto.length > 0) || (exp.empresa !== 'N/A' && exp.empresa.length > 0)) {
              // Verificar que no sea un duplicado (mismo puesto y empresa)
              const isDuplicate = data.experiencia.some(existing => 
                existing.puesto === exp.puesto && existing.empresa === exp.empresa
              );
              
              if (!isDuplicate) {
                data.experiencia.push(exp);
                console.log(`  Experiencia ${data.experiencia.length}: ${exp.puesto} en ${exp.empresa !== 'N/A' ? exp.empresa.substring(0, 30) : 'N/A'}`);
              }
            } else {
              console.log(`  Item ${index + 1} descartado: sin puesto ni empresa válidos`);
            }
          });
          
          console.log(`Total de experiencias procesadas: ${data.experiencia.length} de ${experienceItems.length} items`);
        }
        
        // Si aún no encontramos experiencia, intentar método alternativo más agresivo
        if (data.experiencia.length === 0) {
          console.log('Intentando método alternativo para extraer experiencia...');
          
          // Buscar por ID o data-section
          const altSelectors = [
            '[id="experience"]',
            '[id*="experience"]',
            '[data-section="experience"]',
            'section:has([id*="experience"])',
            'div:has([id*="experience"])'
          ];
          
          for (const altSel of altSelectors) {
            const altSection = document.querySelector(altSel);
            if (altSection) {
              console.log(`Sección alternativa encontrada: ${altSel}`);
              const items = altSection.querySelectorAll('li, div[class*="entity"], div[class*="item"]');
              if (items.length > 0) {
                console.log(`Procesando ${items.length} items de sección alternativa...`);
                items.forEach((item, idx) => {
                  const itemText = item.innerText || '';
                  // Solo procesar si el item tiene suficiente contenido
                  if (itemText.length > 20) {
                    const exp = {};
                    const lines = itemText.split('\n').filter(l => l.trim() && l.trim().length > 0);
                    
                    if (lines.length > 0) {
                      exp.puesto = lines[0].trim();
                      if (lines.length > 1) {
                        exp.empresa = lines[1].trim();
                      } else {
                        exp.empresa = 'N/A';
                      }
                      
                      // Buscar período en el texto
                      const dateMatch = itemText.match(/(\d{4}|\w{3}\s+\d{4})\s*[-–—]\s*(\d{4}|\w{3}\s+\d{4}|actual|present)/i);
                      exp.periodo = dateMatch ? dateMatch[0].trim() : 'N/A';
                      
                      // Buscar ubicación
                      const locationMatch = itemText.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,?\s+[A-Z][a-z]+)/);
                      exp.ubicacion = locationMatch ? locationMatch[1] : 'N/A';
                      
                      // Descripción (todo el texto después de las primeras líneas)
                      if (lines.length > 2) {
                        exp.descripcion = lines.slice(2).join(' ').trim();
                      } else {
                        exp.descripcion = 'N/A';
                      }
                      
                      exp.duracion = 'N/A';
                      exp.tipoEmpleo = 'N/A';
                      
                      if (exp.puesto && exp.puesto.length > 0) {
                        data.experiencia.push(exp);
                      }
                    }
                  }
                });
                
                if (data.experiencia.length > 0) {
                  console.log(`Extraídas ${data.experiencia.length} experiencias con método alternativo`);
                  break;
                }
              }
            }
          }
        }
        
        // Último intento: buscar cualquier lista que contenga información de trabajo
        if (data.experiencia.length === 0) {
          console.log('Último intento: buscando listas con información de trabajo...');
          const allLists = document.querySelectorAll('ul, ol');
          for (const list of allLists) {
            const listText = list.innerText.toLowerCase();
            if ((listText.includes('experience') || listText.includes('experiencia') || listText.includes('work')) && 
                list.querySelectorAll('li').length > 0) {
              const listItems = list.querySelectorAll('li');
              console.log(`Lista alternativa encontrada con ${listItems.length} items`);
              
              listItems.forEach((item) => {
                const itemText = item.innerText || '';
                if (itemText.length > 30) { // Solo items con suficiente contenido
                  const lines = itemText.split('\n').filter(l => l.trim());
                  if (lines.length >= 2) {
                    const exp = {
                      puesto: lines[0].trim(),
                      empresa: lines[1].trim() || 'N/A',
                      periodo: 'N/A',
                      ubicacion: 'N/A',
                      descripcion: lines.slice(2).join(' ').trim() || 'N/A',
                      duracion: 'N/A',
                      tipoEmpleo: 'N/A'
                    };
                    
                    // Buscar período
                    const dateMatch = itemText.match(/(\d{4}|\w{3}\s+\d{4})\s*[-–—]\s*(\d{4}|\w{3}\s+\d{4}|actual|present)/i);
                    if (dateMatch) {
                      exp.periodo = dateMatch[0].trim();
                    }
                    
                    if (exp.puesto && exp.puesto.length > 0 && exp.puesto !== 'N/A') {
                      data.experiencia.push(exp);
                    }
                  }
                }
              });
              
              if (data.experiencia.length > 0) break;
            }
          }
        }
        
        console.log(`Total de experiencias extraídas: ${data.experiencia.length}`);
        
        // Educación detallada - múltiples selectores
        const educationSelectors = [
          '#education ~ .pvs-list',
          '[id*="education"] ~ .pvs-list',
          'section[data-section="education"] .pvs-list',
          '#education-section .pvs-list'
        ];
        
        let educationSection = null;
        for (const selector of educationSelectors) {
          educationSection = document.querySelector(selector);
          if (educationSection) break;
        }
        
        data.educacion = [];
        if (educationSection) {
          const educationItems = educationSection.querySelectorAll('.pvs-list__paged-list-item, li[class*="education"], .pvs-entity');
          educationItems.forEach((item) => {
            const edu = {};
            edu.institucion = getText([
              '.mr1.t-bold span[aria-hidden="true"]',
              '.t-bold span[aria-hidden="true"]',
              'h3 span[aria-hidden="true"]',
              '.pvs-entity__summary-info h3'
            ]);
            edu.titulo = getText([
              '.t-14.t-normal span[aria-hidden="true"]',
              '.t-normal span[aria-hidden="true"]',
              '.pvs-entity__summary-info .t-14'
            ]);
            
            // Años de estudio
            const periodElement = item.querySelector('.t-14.t-normal.t-black--light, .t-black--light');
            edu.periodo = periodElement ? periodElement.innerText.trim() : 'N/A';
            
            // Descripción adicional
            const descElement = item.querySelector('.inline-show-more-text, .pv-shared-text-with-see-more');
            edu.descripcion = descElement ? descElement.innerText.trim() : 'N/A';
            
            // Calificaciones/Logros
            const achievements = item.querySelectorAll('[class*="achievement"], [class*="grade"]');
            edu.logros = Array.from(achievements).map(a => a.innerText.trim()).filter(t => t);
            
            // Solo agregar si tiene institución
            if (edu.institucion !== 'N/A') {
              data.educacion.push(edu);
            }
          });
        }
        
        // Habilidades con endorsements - múltiples selectores
        const skillsSelectors = [
          '#skills ~ .pvs-list',
          '[id*="skills"] ~ .pvs-list',
          'section[data-section="skills"] .pvs-list',
          '#skills-section .pvs-list',
          '.pvs-list[data-section="skills"]'
        ];
        
        let skillsSection = null;
        for (const selector of skillsSelectors) {
          skillsSection = document.querySelector(selector);
          if (skillsSection) break;
        }
        
        data.habilidades = [];
        if (skillsSection) {
          const skillItems = skillsSection.querySelectorAll('.pvs-list__paged-list-item, li[class*="skill"], .pvs-entity, .pills');
          skillItems.forEach((item) => {
            const skillElement = item.querySelector('.mr1.t-bold span[aria-hidden="true"], [class*="skill-name"], span[class*="skill"], .pvs-entity__summary-info h3');
            if (skillElement && skillElement.innerText && skillElement.innerText.trim()) {
              const skillName = skillElement.innerText.trim();
              const endorsementElement = item.querySelector('[class*="endorsement"], [aria-label*="endorsement"], .pvs-entity__summary-info-v2');
              let endorsements = 0;
              if (endorsementElement) {
                const endorsementText = endorsementElement.innerText || '';
                const match = endorsementText.match(/(\d+)/);
                if (match) {
                  endorsements = parseInt(match[1]);
                }
              }
              
              data.habilidades.push({
                nombre: skillName,
                endorsements: endorsements
              });
            }
          });
        }
        
        // Certificaciones - múltiples selectores
        const certSelectors = [
          '#licenses_and_certifications ~ .pvs-list',
          '[id*="certification"] ~ .pvs-list',
          'section[data-section="licenses_and_certifications"] .pvs-list',
          '[id*="licenses"] ~ .pvs-list'
        ];
        
        let certificationsSection = null;
        for (const selector of certSelectors) {
          certificationsSection = document.querySelector(selector);
          if (certificationsSection) break;
        }
        
        data.certificaciones = [];
        if (certificationsSection) {
          const certItems = certificationsSection.querySelectorAll('.pvs-list__paged-list-item, .pvs-entity');
          certItems.forEach((item) => {
            const cert = {};
            cert.nombre = getText([
              '.mr1.t-bold span[aria-hidden="true"]',
              '.t-bold span[aria-hidden="true"]',
              'h3 span[aria-hidden="true"]'
            ]);
            cert.organizacion = getText([
              '.t-14.t-normal span[aria-hidden="true"]',
              '.t-normal span[aria-hidden="true"]'
            ]);
            cert.fecha = getText([
              '.t-14.t-normal.t-black--light',
              '.t-black--light'
            ]);
            cert.credentialId = getText([
              '[class*="credential"]',
              '.pvs-entity__summary-info-v2'
            ]);
            if (cert.nombre !== 'N/A') {
              data.certificaciones.push(cert);
            }
          });
        }
        
        // Proyectos - múltiples selectores
        const projectSelectors = [
          '#projects ~ .pvs-list',
          '[id*="project"] ~ .pvs-list',
          'section[data-section="projects"] .pvs-list'
        ];
        
        let projectsSection = null;
        for (const selector of projectSelectors) {
          projectsSection = document.querySelector(selector);
          if (projectsSection) break;
        }
        
        data.proyectos = [];
        if (projectsSection) {
          const projectItems = projectsSection.querySelectorAll('.pvs-list__paged-list-item, .pvs-entity');
          projectItems.forEach((item) => {
            const project = {};
            project.nombre = getText([
              '.mr1.t-bold span[aria-hidden="true"]',
              '.t-bold span[aria-hidden="true"]',
              'h3 span[aria-hidden="true"]'
            ]);
            project.descripcion = getText([
              '.inline-show-more-text',
              '.pv-shared-text-with-see-more',
              '[class*="description"]'
            ]);
            project.fecha = getText([
              '.t-14.t-normal.t-black--light',
              '.t-black--light'
            ]);
            const projectLink = item.querySelector('a[href]');
            project.url = projectLink ? projectLink.href : 'N/A';
            if (project.nombre !== 'N/A') {
              data.proyectos.push(project);
            }
          });
        }
        
        // Idiomas - múltiples selectores
        const languageSelectors = [
          '#languages ~ .pvs-list',
          '[id*="language"] ~ .pvs-list',
          'section[data-section="languages"] .pvs-list'
        ];
        
        let languagesSection = null;
        for (const selector of languageSelectors) {
          languagesSection = document.querySelector(selector);
          if (languagesSection) break;
        }
        
        data.idiomas = [];
        if (languagesSection) {
          const languageItems = languagesSection.querySelectorAll('.pvs-list__paged-list-item, .pvs-entity');
          languageItems.forEach((item) => {
            const lang = {};
            lang.idioma = getText([
              '.mr1.t-bold span[aria-hidden="true"]',
              '.t-bold span[aria-hidden="true"]',
              'h3 span[aria-hidden="true"]'
            ]);
            lang.nivel = getText([
              '.t-14.t-normal',
              '.t-normal',
              '.pvs-entity__summary-info-v2'
            ]);
            if (lang.idioma !== 'N/A') {
              data.idiomas.push(lang);
            }
          });
        }
        
        // Voluntariado - múltiples selectores
        const volunteerSelectors = [
          '#volunteer_experiences ~ .pvs-list',
          '[id*="volunteer"] ~ .pvs-list',
          'section[data-section="volunteer"] .pvs-list'
        ];
        
        let volunteerSection = null;
        for (const selector of volunteerSelectors) {
          volunteerSection = document.querySelector(selector);
          if (volunteerSection) break;
        }
        
        data.voluntariado = [];
        if (volunteerSection) {
          const volunteerItems = volunteerSection.querySelectorAll('.pvs-list__paged-list-item, .pvs-entity');
          volunteerItems.forEach((item) => {
            const vol = {};
            vol.organizacion = getText([
              '.mr1.t-bold span[aria-hidden="true"]',
              '.t-bold span[aria-hidden="true"]',
              'h3 span[aria-hidden="true"]'
            ]);
            vol.rol = getText([
              '.t-14.t-normal span[aria-hidden="true"]',
              '.t-normal span[aria-hidden="true"]'
            ]);
            vol.periodo = getText([
              '.t-14.t-normal.t-black--light',
              '.t-black--light'
            ]);
            vol.descripcion = getText([
              '.inline-show-more-text',
              '.pv-shared-text-with-see-more'
            ]);
            if (vol.organizacion !== 'N/A') {
              data.voluntariado.push(vol);
            }
          });
        }
        
        // Cursos - múltiples selectores
        const courseSelectors = [
          '#courses ~ .pvs-list',
          '[id*="course"] ~ .pvs-list',
          'section[data-section="courses"] .pvs-list'
        ];
        
        let coursesSection = null;
        for (const selector of courseSelectors) {
          coursesSection = document.querySelector(selector);
          if (coursesSection) break;
        }
        
        data.cursos = [];
        if (coursesSection) {
          const courseItems = coursesSection.querySelectorAll('.pvs-list__paged-list-item, .pvs-entity');
          courseItems.forEach((item) => {
            const course = getText([
              '.mr1.t-bold span[aria-hidden="true"]',
              '.t-bold span[aria-hidden="true"]',
              'h3 span[aria-hidden="true"]'
            ]);
            if (course !== 'N/A') {
              data.cursos.push(course);
            }
          });
        }
        
        // Publicaciones - múltiples selectores
        const publicationSelectors = [
          '#publications ~ .pvs-list',
          '[id*="publication"] ~ .pvs-list',
          'section[data-section="publications"] .pvs-list'
        ];
        
        let publicationsSection = null;
        for (const selector of publicationSelectors) {
          publicationsSection = document.querySelector(selector);
          if (publicationsSection) break;
        }
        
        data.publicaciones = [];
        if (publicationsSection) {
          const pubItems = publicationsSection.querySelectorAll('.pvs-list__paged-list-item, .pvs-entity');
          pubItems.forEach((item) => {
            const pub = {};
            pub.titulo = getText([
              '.mr1.t-bold span[aria-hidden="true"]',
              '.t-bold span[aria-hidden="true"]',
              'h3 span[aria-hidden="true"]'
            ]);
            pub.autores = getText([
              '.t-14.t-normal span[aria-hidden="true"]',
              '.t-normal span[aria-hidden="true"]'
            ]);
            pub.fecha = getText([
              '.t-14.t-normal.t-black--light',
              '.t-black--light'
            ]);
            pub.descripcion = getText([
              '.inline-show-more-text',
              '.pv-shared-text-with-see-more'
            ]);
            const pubLink = item.querySelector('a[href]');
            pub.url = pubLink ? pubLink.href : 'N/A';
            if (pub.titulo !== 'N/A') {
              data.publicaciones.push(pub);
            }
          });
        }
        
        // Premios y reconocimientos - múltiples selectores
        const honorSelectors = [
          '#honors_and_awards ~ .pvs-list',
          '[id*="honor"] ~ .pvs-list',
          'section[data-section="honors"] .pvs-list'
        ];
        
        let honorsSection = null;
        for (const selector of honorSelectors) {
          honorsSection = document.querySelector(selector);
          if (honorsSection) break;
        }
        
        data.premios = [];
        if (honorsSection) {
          const honorItems = honorsSection.querySelectorAll('.pvs-list__paged-list-item, .pvs-entity');
          honorItems.forEach((item) => {
            const honor = {};
            honor.titulo = getText([
              '.mr1.t-bold span[aria-hidden="true"]',
              '.t-bold span[aria-hidden="true"]',
              'h3 span[aria-hidden="true"]'
            ]);
            honor.organizacion = getText([
              '.t-14.t-normal span[aria-hidden="true"]',
              '.t-normal span[aria-hidden="true"]'
            ]);
            honor.fecha = getText([
              '.t-14.t-normal.t-black--light',
              '.t-black--light'
            ]);
            honor.descripcion = getText([
              '.inline-show-more-text',
              '.pv-shared-text-with-see-more'
            ]);
            if (honor.titulo !== 'N/A') {
              data.premios.push(honor);
            }
          });
        }
        
        // Organizaciones - múltiples selectores
        const organizationSelectors = [
          '#organizations ~ .pvs-list',
          '[id*="organization"] ~ .pvs-list',
          'section[data-section="organizations"] .pvs-list'
        ];
        
        let organizationsSection = null;
        for (const selector of organizationSelectors) {
          organizationsSection = document.querySelector(selector);
          if (organizationsSection) break;
        }
        
        data.organizaciones = [];
        if (organizationsSection) {
          const orgItems = organizationsSection.querySelectorAll('.pvs-list__paged-list-item, .pvs-entity');
          orgItems.forEach((item) => {
            const org = {};
            org.nombre = getText([
              '.mr1.t-bold span[aria-hidden="true"]',
              '.t-bold span[aria-hidden="true"]',
              'h3 span[aria-hidden="true"]'
            ]);
            org.rol = getText([
              '.t-14.t-normal span[aria-hidden="true"]',
              '.t-normal span[aria-hidden="true"]'
            ]);
            org.periodo = getText([
              '.t-14.t-normal.t-black--light',
              '.t-black--light'
            ]);
            if (org.nombre !== 'N/A') {
              data.organizaciones.push(org);
            }
          });
        }
        
        // Patentes - múltiples selectores
        const patentSelectors = [
          '#patents ~ .pvs-list',
          '[id*="patent"] ~ .pvs-list',
          'section[data-section="patents"] .pvs-list'
        ];
        
        let patentsSection = null;
        for (const selector of patentSelectors) {
          patentsSection = document.querySelector(selector);
          if (patentsSection) break;
        }
        
        data.patentes = [];
        if (patentsSection) {
          const patentItems = patentsSection.querySelectorAll('.pvs-list__paged-list-item, .pvs-entity');
          patentItems.forEach((item) => {
            const patent = {};
            patent.titulo = getText([
              '.mr1.t-bold span[aria-hidden="true"]',
              '.t-bold span[aria-hidden="true"]',
              'h3 span[aria-hidden="true"]'
            ]);
            patent.numero = getText([
              '.t-14.t-normal span[aria-hidden="true"]',
              '.t-normal span[aria-hidden="true"]'
            ]);
            patent.fecha = getText([
              '.t-14.t-normal.t-black--light',
              '.t-black--light'
            ]);
            patent.descripcion = getText([
              '.inline-show-more-text',
              '.pv-shared-text-with-see-more'
            ]);
            if (patent.titulo !== 'N/A') {
              data.patentes.push(patent);
            }
          });
        }
        
        // Testimonios/Recomendaciones (número)
        const recommendationsSection = document.querySelector('[class*="recommendation"], [id*="recommendation"]');
        data.recomendaciones = {
          recibidas: 0,
          dadas: 0
        };
        if (recommendationsSection) {
          const recText = recommendationsSection.innerText;
          const receivedMatch = recText.match(/(\d+)\s*(recomendaciones?\s*recibidas?|received)/i);
          const givenMatch = recText.match(/(\d+)\s*(recomendaciones?\s*dadas?|given)/i);
          data.recomendaciones.recibidas = receivedMatch ? parseInt(receivedMatch[1]) : 0;
          data.recomendaciones.dadas = givenMatch ? parseInt(givenMatch[1]) : 0;
        }
        
        // URL de imagen de perfil
        const imageElement = document.querySelector('.pv-top-card-profile-picture__image, img[alt*="profile"], [class*="profile-picture"] img');
        data.imagenPerfil = imageElement ? imageElement.src : 'N/A';
        
        // URL del perfil
        data.urlPerfil = window.location.href.split('?')[0];
        
        // Fecha de extracción
        data.fechaExtraccion = new Date().toISOString();
        
        return data;
      }, profileName, contactInfo);

      if (experienceFromDetailsPage.length > 0) {
        profileData.experiencia = experienceFromDetailsPage;
        console.log(`  Experiencia laboral tomada de /details/experience/: ${profileData.experiencia.length} entradas`);
      }

      return profileData;
    } catch (error) {
      console.error('Error obteniendo detalles del perfil:', error.message);
      return null;
    }
  }

  // Limpiar cookies guardadas (forzar nuevo login)
  clearCookies() {
    try {
      if (existsSync(this.cookiesFile)) {
        fs.unlinkSync(this.cookiesFile);
        console.log('✓ Cookies eliminadas. Se requerirá login en la próxima ejecución.');
        return true;
      }
      return false;
    } catch (error) {
      console.error('Error eliminando cookies:', error.message);
      return false;
    }
  }

  async close() {
    if (this.browser) {
      // Intentar guardar cookies antes de cerrar, pero con manejo de errores
      try {
        // Verificar que la página esté disponible antes de intentar guardar
        if (this.page && !this.page.isClosed()) {
          // Usar un timeout corto para no bloquear el cierre
          await Promise.race([
            this.saveCookies(),
            new Promise(resolve => setTimeout(resolve, 1000))
          ]);
        }
      } catch (error) {
        // Ignorar todos los errores al cerrar
      }
      
      try {
        await this.browser.close();
        console.log('Navegador cerrado');
      } catch (error) {
        // Ignorar errores si el navegador ya está cerrado
      }
    }
  }
}

// Función para leer URLs de exclusión desde un archivo
function readExclusionUrls(filePath) {
  try {
    if (!existsSync(filePath)) {
      return [];
    }
    
    const content = fs.readFileSync(filePath, 'utf-8');
    const extension = filePath.split('.').pop().toLowerCase();
    
    let urls = [];
    
    if (extension === 'json') {
      const data = JSON.parse(content);
      // Si es un array de strings (URLs)
      if (Array.isArray(data)) {
        urls = data;
      }
      // Si es un objeto con una propiedad 'urls' o 'exclusiones'
      else if (data.urls && Array.isArray(data.urls)) {
        urls = data.urls;
      }
      else if (data.exclusiones && Array.isArray(data.exclusiones)) {
        urls = data.exclusiones;
      }
      // Si es un array de objetos con propiedad 'url' o 'urlPerfil'
      else if (Array.isArray(data) && data[0] && typeof data[0] === 'object') {
        urls = data.map(item => item.url || item.urlPerfil || item.linkedin || item.perfil).filter(Boolean);
      }
    } else if (extension === 'csv' || extension === 'txt') {
      // Leer CSV o TXT (una URL por línea)
      urls = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'));
    }
    
    // Normalizar URLs y filtrar solo las de LinkedIn
    return urls
      .map(url => {
        if (typeof url !== 'string') return null;
        
        // Limpiar la URL
        url = url.trim();
        
        // Agregar https:// si no tiene protocolo
        if (!url.startsWith('http')) {
          url = 'https://' + url;
        }
        
        // Verificar que sea una URL de LinkedIn
        if (!url.includes('linkedin.com/in/')) {
          return null;
        }
        
        // Normalizar: remover parámetros de query y fragmentos
        try {
          const urlObj = new URL(url);
          return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`.replace(/\/$/, '');
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
      
  } catch (error) {
    console.error(`Error leyendo archivo de exclusiones ${filePath}:`, error.message);
    return [];
  }
}

// Función para normalizar URLs de LinkedIn para comparación
function normalizeLinkedInUrl(url) {
  if (!url || typeof url !== 'string') return '';
  
  try {
    // Si no tiene protocolo, agregarlo
    if (!url.startsWith('http')) {
      url = 'https://' + url;
    }
    
    const urlObj = new URL(url);
    
    // Solo procesar URLs de LinkedIn
    if (!urlObj.hostname.includes('linkedin.com')) {
      return '';
    }
    
    // Normalizar: protocolo + host + pathname (sin query params ni fragmentos)
    return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`.replace(/\/$/, '');
  } catch (e) {
    return '';
  }
}

// Función para verificar si un perfil debe ser excluido
function shouldExcludeProfile(profile, exclusionUrls) {
  if (!exclusionUrls || exclusionUrls.length === 0) {
    return false;
  }
  
  const profileUrl = normalizeLinkedInUrl(profile.urlPerfil);
  if (!profileUrl) {
    return false;
  }
  
  // Verificar si la URL del perfil está en la lista de exclusiones
  return exclusionUrls.some(excludeUrl => {
    const normalizedExcludeUrl = normalizeLinkedInUrl(excludeUrl);
    return normalizedExcludeUrl && profileUrl === normalizedExcludeUrl;
  });
}

// Función para leer nombres desde un archivo
function readNamesFromFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const extension = filePath.split('.').pop().toLowerCase();
    
    if (extension === 'json') {
      const data = JSON.parse(content);
      // Si es un array de strings
      if (Array.isArray(data)) {
        return data;
      }
      // Si es un objeto con una propiedad 'nombres'
      if (data.nombres && Array.isArray(data.nombres)) {
        return data.nombres;
      }
      // Si es un array de objetos con propiedad 'nombre'
      if (Array.isArray(data) && data[0] && typeof data[0] === 'object' && data[0].nombre) {
        return data.map(item => item.nombre);
      }
    } else if (extension === 'csv' || extension === 'txt') {
      // Leer CSV o TXT (una línea por nombre)
      return content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'));
    }
    
    return [];
  } catch (error) {
    console.error(`Error leyendo archivo ${filePath}:`, error.message);
    return [];
  }
}

// Función para búsqueda masiva
async function massiveSearch(scraper, names, options = {}) {
  const {
    getFullDetails = true, // Por defecto obtener detalles completos
    delayBetweenSearches = 5000, // 5 segundos por defecto
    maxProfilesPerSearch = 25, // Límite de perfiles por búsqueda
    filterKeywords = null, // Palabras clave para filtrar
    exclusionUrls = [] // URLs de LinkedIn para excluir
  } = options;
  
  const allResults = [];
  const stats = {
    total: names.length,
    completed: 0,
    failed: 0,
    profilesFound: 0,
    profilesFiltered: 0,
    profilesExcluded: 0
  };
  
  console.log(`\n=== Iniciando búsqueda masiva ===`);
  console.log(`Total de búsquedas: ${stats.total}`);
  console.log(`Delay entre búsquedas: ${delayBetweenSearches / 1000}s`);
  console.log(`Obtener detalles completos: ${getFullDetails ? 'Sí' : 'No'}`);
  if (filterKeywords && filterKeywords.length > 0) {
    console.log(`Filtros de palabras clave: ${filterKeywords.join(', ')}`);
  }
  if (exclusionUrls && exclusionUrls.length > 0) {
    console.log(`URLs de exclusión cargadas: ${exclusionUrls.length} perfiles`);
  }
  console.log(`Máximo de perfiles por búsqueda: ${maxProfilesPerSearch}\n`);
  
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    console.log(`\n[${i + 1}/${stats.total}] Buscando: ${name}`);
    
    try {
      // Buscar personas con opciones
      const profiles = await scraper.searchPerson(name, {
        getFullDetails: getFullDetails,
        filterKeywords: filterKeywords,
        maxResults: maxProfilesPerSearch,
        exclusionUrls: exclusionUrls
      });
      
      if (profiles.length === 0) {
        console.log(`  ⚠ No se encontraron perfiles para "${name}".`);
        stats.failed++;
      } else {
        console.log(`  ✓ Encontrados ${profiles.length} perfiles`);
        stats.profilesFound += profiles.length;
        if (filterKeywords) {
          stats.profilesFiltered += profiles.length;
        }
        
        // Agregar resultados con metadata
        allResults.push({
          busqueda: name,
          fecha: new Date().toISOString(),
          cantidadPerfiles: profiles.length,
          perfiles: profiles
        });
      }
      
      stats.completed++;
      
      // Delay entre búsquedas (excepto en la última)
      if (i < names.length - 1) {
        console.log(`  Esperando ${delayBetweenSearches / 1000}s antes de la siguiente búsqueda...`);
        await new Promise(resolve => setTimeout(resolve, delayBetweenSearches));
      }
      
    } catch (error) {
      console.error(`  ✗ Error buscando "${name}":`, error.message);
      stats.failed++;
      allResults.push({
        busqueda: name,
        fecha: new Date().toISOString(),
        error: error.message,
        perfiles: []
      });
    }
  }
  
  return { results: allResults, stats };
}

// Función principal
async function main() {
  setupHistoryLog();

  const scraper = new LinkedInScraper();
  
  try {
    // Inicializar el scraper
    await scraper.init();
    
    // Verificar si hay sesión activa
    console.log('Verificando sesión activa...');
    const sessionActive = await scraper.isSessionActive();
    
    if (!sessionActive) {
      console.log('No hay sesión activa. Iniciando sesión...');
      
      // Obtener credenciales del archivo .env
      const email = process.env.LINKEDIN_EMAIL;
      const password = process.env.LINKEDIN_PASSWORD;
      
      if (!email || !password) {
        console.error('Error: Debes configurar LINKEDIN_EMAIL y LINKEDIN_PASSWORD en el archivo .env');
        await scraper.close();
        return;
      }
      
      // Iniciar sesión
      const loginSuccess = await scraper.login(email, password);
      if (!loginSuccess) {
        await scraper.close();
        return;
      }
    } else {
      console.log('✓ Sesión activa encontrada. Continuando sin login...');
    }
    
    // Verificar si se quiere limpiar la sesión
    if (process.argv.includes('--clear-session') || process.argv.includes('--clear')) {
      scraper.clearCookies();
      console.log('Sesión limpiada. Ejecuta nuevamente para hacer login.');
      await scraper.close();
      return;
    }
    
    // Obtener argumentos de línea de comandos
    // Por defecto obtener detalles completos (a menos que se especifique --no-details)
    const getDetails = !process.argv.includes('--no-details') && (process.argv.includes('--details') || process.argv.includes('-d') || true);
    const delayArg = process.argv.find(arg => arg.startsWith('--delay='));
    const delay = delayArg ? parseInt(delayArg.split('=')[1]) * 1000 : 5000;
    
    // Obtener palabras clave para filtrar
    const keywordsArg = process.argv.find(arg => arg.startsWith('--keywords=') || arg.startsWith('--filter='));
    let filterKeywords = null;
    if (keywordsArg) {
      const keywordsValue = keywordsArg.split('=')[1];
      filterKeywords = keywordsValue.split(',').map(k => k.trim()).filter(k => k.length > 0);
    }
    
    // Obtener exclusiones (archivo o URLs directas)
    const excludeFileArg = process.argv.find(arg => arg.startsWith('--exclude-file='));
    const excludeUrlsArg = process.argv.find(arg => arg.startsWith('--exclude-urls=') || arg.startsWith('--exclude='));
    let exclusionUrls = [];
    
    // Cargar desde archivo si se especifica --exclude-file
    if (excludeFileArg) {
      const excludeFile = excludeFileArg.split('=')[1];
      console.log(`Cargando exclusiones desde archivo: ${excludeFile}`);
      exclusionUrls = readExclusionUrls(excludeFile);
      if (exclusionUrls.length > 0) {
        console.log(`✓ Cargadas ${exclusionUrls.length} URLs de exclusión desde archivo`);
      } else {
        console.log('⚠ No se encontraron URLs de exclusión válidas en el archivo');
      }
    }
    // Cargar URLs directas si se especifica --exclude-urls o --exclude
    else if (excludeUrlsArg) {
      const excludeValue = excludeUrlsArg.split('=')[1];
      
      // Verificar si el valor parece ser un archivo (tiene extensión) o URLs directas
      const isFile = excludeValue.includes('.') && !excludeValue.includes('linkedin.com');
      
      if (isFile) {
        // Es un archivo
        console.log(`Cargando exclusiones desde archivo: ${excludeValue}`);
        exclusionUrls = readExclusionUrls(excludeValue);
        if (exclusionUrls.length > 0) {
          console.log(`✓ Cargadas ${exclusionUrls.length} URLs de exclusión desde archivo`);
        } else {
          console.log('⚠ No se encontraron URLs de exclusión válidas en el archivo');
        }
      } else {
        // Son URLs directas separadas por coma
        console.log('Procesando URLs de exclusión directas...');
        const rawUrls = excludeValue.split(',').map(url => url.trim()).filter(url => url.length > 0);
        
        // Normalizar y validar URLs
        exclusionUrls = rawUrls
          .map(url => {
            // Limpiar la URL
            url = url.trim();
            
            // Agregar https:// si no tiene protocolo
            if (!url.startsWith('http')) {
              url = 'https://' + url;
            }
            
            // Verificar que sea una URL de LinkedIn
            if (!url.includes('linkedin.com/in/')) {
              console.log(`⚠ URL ignorada (no es de LinkedIn): ${url}`);
              return null;
            }
            
            // Normalizar: remover parámetros de query y fragmentos
            try {
              const urlObj = new URL(url);
              return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`.replace(/\/$/, '');
            } catch (e) {
              console.log(`⚠ URL inválida ignorada: ${url}`);
              return null;
            }
          })
          .filter(Boolean);
          
        if (exclusionUrls.length > 0) {
          console.log(`✓ Procesadas ${exclusionUrls.length} URLs de exclusión directas`);
          exclusionUrls.forEach((url, index) => {
            console.log(`  ${index + 1}. ${url}`);
          });
        } else {
          console.log('⚠ No se encontraron URLs de exclusión válidas');
        }
      }
    }
    
    // Obtener máximo de resultados por búsqueda (--max=N o --max N)
    let maxResults = 25;
    const maxIdx = process.argv.findIndex(arg => arg === '--max' || arg.startsWith('--max='));
    if (maxIdx !== -1) {
      const arg = process.argv[maxIdx];
      const value = arg.startsWith('--max=') ? arg.split('=')[1] : process.argv[maxIdx + 1];
      const parsed = parseInt(value, 10);
      if (!isNaN(parsed) && parsed >= 1) {
        maxResults = parsed;
        console.log(`[DEBUG] --max detectado: ${maxResults} perfiles máximo`);
      }
    }
    console.log(`[DEBUG] process.argv: ${JSON.stringify(process.argv)}`);
    
    // Verificar si se usa --url (buscar en todos los argumentos)
    const urlArg = process.argv.find(arg => arg.startsWith('--url=') || arg === '--url');
    let urlValue = null;
    
    if (urlArg) {
      if (urlArg.includes('=')) {
        // Extraer el valor después del =
        urlValue = urlArg.split('=').slice(1).join('='); // Usar slice y join por si hay = en la URL
        // Remover comillas si las tiene
        urlValue = urlValue.replace(/^["']|["']$/g, '');
      } else {
        // Si --url está sin =, buscar el siguiente argumento
        const urlIndex = process.argv.indexOf('--url');
        if (urlIndex !== -1 && process.argv[urlIndex + 1]) {
          urlValue = process.argv[urlIndex + 1].replace(/^["']|["']$/g, '');
        }
      }
    }
    
    // Obtener el input (primer argumento que no sea un flag)
    const input = process.argv.find((arg, index) => {
      // Saltar node y index.js
      if (index < 2) return false;
      // Si ya encontramos --url, no usar este como input
      if (urlValue) return false;
      // No usar flags como input
      if (arg.startsWith('--')) return false;
      return true;
    }) || process.argv[2];
    
    // Verificar si el input es una URL de LinkedIn
    const isLinkedInUrl = input && (
      input.startsWith('https://www.linkedin.com/in/') ||
      input.startsWith('http://www.linkedin.com/in/') ||
      input.startsWith('https://linkedin.com/in/') ||
      input.startsWith('http://linkedin.com/in/') ||
      input.includes('linkedin.com/in/')
    );
    
    const useUrlMode = urlValue || isLinkedInUrl;
    
    if (!input) {
      console.log('Uso:');
      console.log('  Búsqueda individual:');
      console.log('    node index.js "Nombre a buscar"');
      console.log('    node index.js "Juan" --keywords="desarrollador,javascript"');
      console.log('    node index.js "María" --filter="marketing,digital" --max=10');
      console.log('');
      console.log('  Obtener detalles desde URL:');
      console.log('    npm start "https://www.linkedin.com/in/usuario/"');
      console.log('    npm start -- --url="https://www.linkedin.com/in/usuario/"');
      console.log('    node index.js "https://www.linkedin.com/in/usuario/"');
      console.log('    node index.js --url="https://www.linkedin.com/in/usuario/"');
      console.log('');
      console.log('  Búsqueda masiva desde archivo:');
      console.log('    node index.js nombres.json');
      console.log('    node index.js nombres.csv --keywords="ingeniero,software"');
      console.log('    node index.js nombres.txt --delay=10 --max=15');
      console.log('');
      console.log('Opciones:');
      console.log('  --headless              Usar navegador sin ventana (modo servidor). Por defecto si HEADLESS no es false en .env');
      console.log('  --no-headless           Usar navegador con ventana visible (igual que --browser)');
      console.log('  --browser               Alias de --no-headless (ver el navegador)');
      console.log('  --details, -d           Obtener detalles completos (por defecto: activado)');
      console.log('  --keywords=palabras     Filtrar por palabras clave (separadas por coma)');
      console.log('  --filter=palabras       Alias de --keywords');
      console.log('  --max=N                 Máximo de perfiles por búsqueda (default: 25)');
      console.log('  --delay=N               Delay en segundos entre búsquedas (default: 5)');
      console.log('  --url=URL               Obtener detalles directamente desde URL de perfil');
      console.log('  --exclude=urls_o_archivo Excluir perfiles: URLs separadas por coma o archivo');
      console.log('  --exclude-urls=urls     Excluir perfiles por URLs (separadas por coma)');
      console.log('  --exclude-file=archivo  Excluir perfiles por URLs desde archivo');
      console.log('  --clear-session         Limpiar sesión guardada (forzar nuevo login)');
      console.log('');
      console.log('Ejemplos:');
      console.log('  # Buscar "Juan" y filtrar por "desarrollador" o "programador"');
      console.log('  node index.js "Juan" --keywords="desarrollador,programador"');
      console.log('');
      console.log('  # Buscar excluyendo perfiles específicos por URLs directas');
      console.log('  node index.js "Juan" --exclude="linkedin.com/in/usuario1,linkedin.com/in/usuario2"');
      console.log('  node index.js "María" --exclude-urls="https://linkedin.com/in/excluir1,linkedin.com/in/excluir2"');
      console.log('');
      console.log('  # Buscar excluyendo perfiles desde archivo');
      console.log('  node index.js "Juan" --exclude-file="exclusiones.json"');
      console.log('  node index.js nombres.json --exclude="perfiles_excluir.txt"');
      console.log('');
      console.log('  # Obtener detalles de un perfil específico por URL');
      console.log('  npm start "https://www.linkedin.com/in/juan-perez/"');
      console.log('  npm start -- --url="https://www.linkedin.com/in/juan-perez/"');
      console.log('  node index.js "https://www.linkedin.com/in/juan-perez/"');
      console.log('  node index.js --url="https://www.linkedin.com/in/juan-perez/"');
      console.log('');
      console.log('  # Búsqueda masiva con filtros y exclusiones');
      console.log('  node index.js nombres.json --keywords="marketing,digital" --max=20 --exclude-file="ya_contactados.json"');
      console.log('  node index.js candidatos.csv --exclude="linkedin.com/in/user1,linkedin.com/in/user2" --delay=3');
      console.log('');
      console.log('  # Con o sin ventana del navegador (dinámico por comando)');
      console.log('  node index.js "Juan" --headless          # Sin ventana (servidor)');
      console.log('  node index.js "Juan" --no-headless        # Con ventana visible');
      console.log('  node index.js "Juan" --browser            # Igual que --no-headless');
      await scraper.close();
      return;
    }
    
    // Si es una URL de LinkedIn, obtener detalles directamente
    if (useUrlMode) {
      let profileUrl = urlValue || input;
      
      // Normalizar la URL
      if (!profileUrl.startsWith('http')) {
        profileUrl = 'https://' + profileUrl;
      }
      
      // Asegurar que sea una URL de perfil válida
      if (!profileUrl.includes('linkedin.com/in/')) {
        console.error('Error: La URL debe ser un perfil de LinkedIn (debe contener linkedin.com/in/)');
        await scraper.close();
        return;
      }
      
      console.log(`\n=== Obteniendo detalles del perfil ===`);
      console.log(`URL: ${profileUrl}\n`);
      
      try {
        const profileData = await scraper.getProfileDetails(profileUrl);
        
        if (!profileData) {
          console.log('⚠ No se pudieron obtener los detalles del perfil.');
        } else {
          // Crear estructura similar a la búsqueda para consistencia
          const result = {
            nombre: profileData.nombreCompleto !== 'N/A' ? profileData.nombreCompleto : 'N/A',
            titulo: profileData.headline !== 'N/A' ? profileData.headline : 'N/A',
            ubicacion: profileData.ubicacion !== 'N/A' ? profileData.ubicacion : 'N/A',
            descripcion: profileData.acercaDe !== 'N/A' ? profileData.acercaDe.substring(0, 200) : 'N/A',
            urlPerfil: profileUrl,
            imagenPerfil: profileData.imagenPerfil !== 'N/A' ? profileData.imagenPerfil : 'N/A',
            detallesCompletos: profileData
          };
          
          // Mostrar información básica
          console.log('\n=== Información del Perfil ===\n');
          console.log(`Nombre: ${result.nombre}`);
          console.log(`Título: ${result.titulo}`);
          console.log(`Ubicación: ${result.ubicacion}`);
          if (result.descripcion !== 'N/A' && result.descripcion.length > 0) {
            console.log(`Descripción: ${result.descripcion}...`);
          }
          console.log(`\nExperiencia laboral: ${profileData.experiencia ? profileData.experiencia.length : 0} trabajos encontrados`);
          if (profileData.experiencia && profileData.experiencia.length > 0) {
            console.log('\n--- Experiencia Laboral ---');
            profileData.experiencia.forEach((exp, index) => {
              console.log(`\n${index + 1}. ${exp.puesto !== 'N/A' ? exp.puesto : 'Sin título'}`);
              if (exp.empresa !== 'N/A') {
                console.log(`   Empresa: ${exp.empresa}`);
              }
              if (exp.periodo !== 'N/A') {
                console.log(`   Período: ${exp.periodo}`);
              }
              if (exp.ubicacion !== 'N/A') {
                console.log(`   Ubicación: ${exp.ubicacion}`);
              }
              if (exp.descripcion !== 'N/A' && exp.descripcion.length > 0) {
                console.log(`   Descripción: ${exp.descripcion.substring(0, 150)}...`);
              }
            });
          }
          
          console.log(`\nEducación: ${profileData.educacion ? profileData.educacion.length : 0} registros encontrados`);
          console.log(`Habilidades: ${profileData.habilidades ? profileData.habilidades.length : 0} habilidades encontradas`);
          
          // Guardar resultados en JSON
          const timestamp = Date.now();
          const urlName = profileUrl.split('/in/')[1].replace(/[^a-zA-Z0-9]/g, '_').split('?')[0];
          const outputFile = `perfil_${urlName}_${timestamp}.json`;
          fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf-8');
          console.log(`\n✓ Resultados guardados en: ${outputFile}`);
        }
      } catch (error) {
        console.error('Error obteniendo detalles del perfil:', error.message);
      } finally {
        await scraper.close();
      }
      return;
    }
    
    let names = [];
    let isMassiveSearch = false;
    
    // Verificar si es un archivo
    if (existsSync(input)) {
      console.log(`Leyendo nombres desde archivo: ${input}`);
      names = readNamesFromFile(input);
      isMassiveSearch = true;
      
      if (names.length === 0) {
        console.error('No se encontraron nombres en el archivo o el archivo está vacío.');
        await scraper.close();
        return;
      }
      
      console.log(`Se encontraron ${names.length} nombres para buscar.\n`);
    } else {
      // Es una búsqueda individual
      names = [input];
    }
    
    if (isMassiveSearch) {
      // Búsqueda masiva
      const { results, stats } = await massiveSearch(scraper, names, {
        getFullDetails: getDetails,
        delayBetweenSearches: delay,
        maxProfilesPerSearch: maxResults,
        filterKeywords: filterKeywords,
        exclusionUrls: exclusionUrls
      });
      
      // Guardar resultados
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputFile = `resultados_masivos_${timestamp}.json`;
      
      const output = {
        fecha: new Date().toISOString(),
        estadisticas: stats,
        resultados: results
      };
      
      fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), 'utf-8');
      
      console.log(`\n=== Búsqueda masiva completada ===`);
      console.log(`Total de búsquedas: ${stats.total}`);
      console.log(`Completadas: ${stats.completed}`);
      console.log(`Fallidas: ${stats.failed}`);
      console.log(`Perfiles encontrados: ${stats.profilesFound}`);
      if (filterKeywords) {
        console.log(`Perfiles priorizados por palabras clave: ${stats.profilesFiltered}`);
      }
      if (exclusionUrls && exclusionUrls.length > 0) {
        console.log(`Perfiles excluidos: ${stats.profilesExcluded}`);
      }
      console.log(`\n✓ Resultados guardados en: ${outputFile}`);
      
    } else {
      // Búsqueda individual
      const searchName = names[0];
      console.log(`\n=== Buscando: ${searchName} ===\n`);
      if (filterKeywords && filterKeywords.length > 0) {
        console.log(`Palabras clave para priorizar barrido: ${filterKeywords.join(', ')}\n`);
      }
      
      const profiles = await scraper.searchPerson(searchName, {
        getFullDetails: getDetails,
        filterKeywords: filterKeywords,
        maxResults: maxResults,
        exclusionUrls: exclusionUrls
      });
      
      if (profiles.length === 0) {
        console.log(`No se encontraron perfiles.`);
      } else {
        console.log(`\n✓ Se encontraron ${profiles.length} perfiles:\n`);
        
        // Mostrar resultados básicos
        profiles.forEach((profile, index) => {
          console.log(`\n--- Perfil ${index + 1} ---`);
          console.log(`Nombre: ${profile.nombre}`);
          console.log(`Título: ${profile.titulo}`);
          console.log(`Ubicación: ${profile.ubicacion}`);
          if (profile.descripcion && profile.descripcion !== 'N/A') {
            console.log(`Descripción: ${profile.descripcion.substring(0, 100)}...`);
          }
          console.log(`URL: ${profile.urlPerfil}`);
          if (profile.detallesCompletos) {
            console.log(`✓ Detalles completos obtenidos`);
          }
        });
        
        // Guardar resultados en JSON
        const outputFile = `resultados_${searchName.replace(/\s+/g, '_')}_${Date.now()}.json`;
        fs.writeFileSync(outputFile, JSON.stringify(profiles, null, 2), 'utf-8');
        console.log(`\n✓ Resultados guardados en: ${outputFile}`);
      }
    }
    
  } catch (error) {
    console.error('Error general:', error);
  } finally {
    // Cerrar el navegador después de 5 segundos
    console.log('\nCerrando navegador en 5 segundos...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    await scraper.close();
    if (historyLogStream) {
      try {
        historyLogStream.write(`[${new Date().toISOString()}] EJECUCIÓN FINALIZADA\n`);
        historyLogStream.end();
      } catch (e) {}
    }
  }
}

// Ejecutar si es el archivo principal
// Node.js 18.20.5+ soporta mejor import.meta.url
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Verificar si es el módulo principal
const isMainModule = process.argv[1] && 
                     (process.argv[1].endsWith('index.js') || 
                      process.argv[1].replace(/\\/g, '/').endsWith(__filename.replace(/\\/g, '/')));

if (isMainModule) {
  main().catch(console.error);
}

export default LinkedInScraper;

