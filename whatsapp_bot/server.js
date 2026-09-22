import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3850;
const HOST = process.env.HOST || '127.0.0.1';
const AUTH_DIR = path.join(__dirname, 'auth_session');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Estado en memoria
let sock = null;
let currentQrCode = null;
let connectionStatus = 'waiting_qr'; // 'waiting_qr', 'connected', 'disconnected'
let userPhone = null;

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        currentQrCode = await QRCode.toDataURL(qr, {
          scale: 8,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
        });
        const terminalQr = await QRCode.toString(qr, { type: 'terminal', small: true });
        console.log('\n--- ESCANEA ESTE QR CON TU WHATSAPP ---');
        console.log(terminalQr);
        console.log('----------------------------------------\n');
        connectionStatus = 'waiting_qr';
      } catch (err) {
        console.error('[WhatsApp QR Error]:', err);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      connectionStatus = 'disconnected';
      currentQrCode = null;
      console.log(`[WhatsApp] Conexión cerrada. Reconectar: ${shouldReconnect} (Código: ${statusCode})`);

      if (shouldReconnect) {
        setTimeout(startWhatsApp, 3000);
      }
    } else if (connection === 'open') {
      connectionStatus = 'connected';
      currentQrCode = null;
      const rawId = sock.user?.id || '';
      userPhone = rawId.split(':')[0] || rawId.split('@')[0];
      console.log(`[WhatsApp] ¡Conectado con éxito! Tu número: +${userPhone}`);
    }
  });
}

// Función auxiliar para obtener el JID propio (chat personal / Note to Self)
function getSelfJid() {
  if (!sock || !sock.user) return null;
  const rawId = sock.user.id;
  const cleanNumber = rawId.split(':')[0].replace(/[^0-9]/g, '');
  return `${cleanNumber}@s.whatsapp.net`;
}

// --- Endpoints de la API ---

// 1. Estado de la conexión y QR
app.get('/api/status', (req, res) => {
  res.json({
    status: connectionStatus,
    userPhone: userPhone ? `+${userPhone}` : null,
    qrCode: currentQrCode,
  });
});

// 2. Enviar mensaje de prueba al propio número
app.post('/api/test-message', async (req, res) => {
  if (connectionStatus !== 'connected' || !sock) {
    return res.status(400).json({ success: false, error: 'WhatsApp aún no está conectado. Escanea el QR primero.' });
  }

  try {
    const targetJid = getSelfJid();
    if (!targetJid) {
      return res.status(400).json({ success: false, error: 'No se pudo identificar tu número.' });
    }

    const testText =
      '🎓 *Moodle Task Tracker*\n\n' +
      '¡Conexión establecida con éxito!\n\n' +
      'A partir de ahora recibirás en este chat personal las alertas automáticas de tus nuevas tareas y entregas universitarias.';

    const sent = await sock.sendMessage(targetJid, { text: testText });
    try {
      if (sent?.key) {
        await sock.chatModify(
          {
            markRead: false,
            lastMessages: [{ key: sent.key, messageTimestamp: sent.messageTimestamp }],
          },
          targetJid
        );
      }
    } catch (e) {
      console.log('[WhatsApp Mark Unread Note]:', e.message);
    }
    res.json({ success: true, message: 'Mensaje enviado exitosamente a tu chat personal (marcado como no leído).' });
  } catch (err) {
    console.error('[Send Test Error]:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Endpoint para que la app de Moodle dispare alertas
app.post('/api/send-alert', async (req, res) => {
  if (connectionStatus !== 'connected' || !sock) {
    return res.status(503).json({ success: false, error: 'WhatsApp no está conectado.' });
  }

  const { title, course, due_date, task_url, milestone } = req.body;

  try {
    const targetJid = getSelfJid();
    if (!targetJid) {
      return res.status(400).json({ success: false, error: 'No se pudo identificar tu número.' });
    }

    let header = '🔔 *¡NUEVA TAREA PUBLICADA EN MOODLE!*';
    if (milestone === '8h') {
      header = '🚨 *¡URGENTE! FALTAN MENOS DE 8 HORAS PARA ENTREGAR*';
    } else if (milestone === '1d') {
      header = '⚠️ *RECORDATORIO: ¡FALTA 1 DÍA (24 HORAS)!*';
    } else if (milestone === '2d') {
      header = '⏳ *RECORDATORIO: FALTAN 2 DÍAS PARA ENTREGAR*';
    } else if (milestone === '3d') {
      header = '📅 *RECORDATORIO: FALTAN 3 DÍAS PARA ENTREGAR*';
    }

    let alertText =
      `${header}\n\n` +
      `📝 *Tarea:* ${title}\n` +
      `📚 *Materia:* ${course || 'General'}\n` +
      `⏱️ *Límite:* ${due_date || 'Sin fecha'}\n`;

    if (task_url) {
      alertText += `\n🔗 *Abrir en Moodle:*\n${task_url}`;
    }

    const sent = await sock.sendMessage(targetJid, { text: alertText });
    try {
      if (sent?.key) {
        await sock.chatModify(
          {
            markRead: false,
            lastMessages: [{ key: sent.key, messageTimestamp: sent.messageTimestamp }],
          },
          targetJid
        );
      }
    } catch (e) {
      console.log('[WhatsApp Mark Unread Note]:', e.message);
    }
    console.log(`[WhatsApp Alert - ${milestone || 'new'}] Alerta enviada a +${userPhone}: ${title}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[Send Alert Error]:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Cerrar sesión / Desvincular
app.post('/api/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }
  } catch (e) {
    // Ignorar si ya estaba desconectado
  }

  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
  } catch (e) {
    console.error('Error limpiando sesión:', e);
  }

  connectionStatus = 'waiting_qr';
  userPhone = null;
  currentQrCode = null;

  startWhatsApp();
  res.json({ success: true });
});

// Iniciar servidor y socket de WhatsApp
app.listen(PORT, HOST, () => {
  console.log(`\n======================================================`);
  console.log(`  🚀 Mini Landing de WhatsApp lista en:`);
  console.log(`  👉 http://${HOST}:${PORT}`);
  console.log(`======================================================\n`);
  startWhatsApp();
});
