import { webcrypto } from 'node:crypto';
globalThis.crypto = webcrypto;

import * as baileys from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import sharp from 'sharp';

const {
  makeWASocket,
  useMultiFileAuthState,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  DisconnectReason
} = baileys;

const defaultOwnerNumber = '6285163207556';
const rawOwner = process.env.OWNER_NUMBER || defaultOwnerNumber;
const cleanedOwner = rawOwner.replace(/\D/g, '');
const ownerNumber = cleanedOwner || defaultOwnerNumber;
const ownerJid = `${ownerNumber}@s.whatsapp.net`;

function isFromOwner(msg) {
  const from = msg.key.remoteJid;
  const sender = msg.key.participant || from;

  if (msg.key.fromMe) return true;

  return sender === ownerJid || from === ownerJid;
}

async function createStickerFromImage(buffer) {
  return sharp(buffer)
    .resize(512, 512, {
      fit: 'inside',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .webp({ lossless: true })
    .toBuffer();
}

async function startBot() {
  try {
    console.log('[INFO] Starting WhatsApp sticker bot');
    console.log('[INFO] Owner JID', { ownerJid });

    const { state, saveCreds } = await useMultiFileAuthState('auth');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log('[INFO] Using WhatsApp Web version', { version, isLatest });

    const sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;

      if (update.qr) {
        console.log('[INFO] QR code received, scan it using WhatsApp');
        qrcode.generate(update.qr, { small: true });
      }

      if (connection) {
        console.log('[INFO] Connection state changed', { connection });
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (statusCode === 401) {
          console.error('[ERROR] Logged out from WhatsApp. Delete the auth folder and restart to log in again.');
        } else {
          console.warn('[WARN] Connection closed', { statusCode, shouldReconnect });
        }

        if (shouldReconnect) {
          console.log('[INFO] Attempting to reconnect...');
          setTimeout(startBot, 2000);
        }
      }

      if (connection === 'open') {
        console.log('[INFO] Connection to WhatsApp opened');
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') {
        return;
      }

      const [msg] = messages;
      if (!msg || !msg.message) {
        return;
      }

      if (!isFromOwner(msg)) {
        console.log('[INFO] Ignoring message from non-owner', {
          senderJid: msg.key.participant || msg.key.remoteJid,
          remoteJid: msg.key.remoteJid
        });
        return;
      }

      if (msg.message.imageMessage) {
        try {
          console.log('[INFO] Processing image message for sticker');
          const mediaBuffer = await downloadMediaMessage(
            msg,
            'buffer',
            {},
            { reuploadRequest: sock }
          );
          const stickerBuffer = await createStickerFromImage(mediaBuffer);
          await sock.sendMessage(
            msg.key.remoteJid,
            { sticker: stickerBuffer },
            { quoted: msg }
          );
          console.log('[INFO] Sticker sent successfully');
        } catch (error) {
          console.error('[ERROR] Failed to process image message', error);
        }
        return;
      }

      if (msg.message.videoMessage) {
        try {
          await sock.sendMessage(
            msg.key.remoteJid,
            { text: 'Untuk sekarang aku cuma bisa bikin stiker dari foto ya 😊' },
            { quoted: msg }
          );
          console.log('[INFO] Replied to video message with photo-only notice');
        } catch (error) {
          console.error('[ERROR] Failed to reply to video message', error);
        }
        return;
      }

      const messageTypes = Object.keys(msg.message);
      console.log('[INFO] Non-media message from owner', { messageTypes });
    });
  } catch (error) {
    console.error('[ERROR] Fatal error while starting bot', error);
    setTimeout(startBot, 5000);
  }
}

startBot().catch((error) => {
  console.error('[ERROR] Unhandled fatal error', error);
  process.exit(1);
});
