import { webcrypto } from 'crypto';
global.crypto = webcrypto;

import fs from 'fs';
import { promises as fsPromises } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import baileys, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  jidNormalizedUser
} from '@whiskeysockets/baileys';

const { default: makeWASocket, downloadMediaMessage, DisconnectReason } = baileys;

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

const logger = pino({ level: 'info' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const AUTH_FOLDER = join(__dirname, 'auth');

const rawOwner = process.env.OWNER_NUMBER || '6285163207556';
const ownerDigits = rawOwner.replace(/\D/g, '');
if (!ownerDigits) {
  logger.error('OWNER_NUMBER must contain digits. Set OWNER_NUMBER env variable and restart.');
  process.exit(1);
}

const OWNER_NUMBER = ownerDigits;
const OWNER_JID = jidNormalizedUser(`${OWNER_NUMBER}@s.whatsapp.net`);
const STICKER_COMMANDS = new Set(['!s', '!sticker']);

async function removeAuthFolder() {
  if (fs.existsSync(AUTH_FOLDER)) {
    try {
      await fsPromises.rm(AUTH_FOLDER, { recursive: true, force: true });
      logger.warn('Removed auth folder due to invalid session.');
    } catch (error) {
      logger.error({ err: error }, 'Failed to remove auth folder');
    }
  }
}

function isStickerCommand(caption = '') {
  return STICKER_COMMANDS.has(caption.trim().toLowerCase());
}

function unwrapMessageContent(message) {
  if (!message?.message) {
    return null;
  }

  if (message.message.ephemeralMessage?.message) {
    return message.message.ephemeralMessage.message;
  }

  if (message.message.viewOnceMessageV2?.message) {
    return message.message.viewOnceMessageV2.message;
  }

  return message.message;
}

function isFromOwner(message) {
  if (!message) {
    return false;
  }

  if (message.key.fromMe) {
    return true;
  }

  const remoteJid = message.key.remoteJid;
  const participant = message.key.participant;

  if (!remoteJid) {
    return false;
  }

  try {
    const normalizedRemote = jidNormalizedUser(remoteJid);
    if (normalizedRemote === OWNER_JID) {
      return true;
    }

    if (participant) {
      const normalizedParticipant = jidNormalizedUser(participant);
      return normalizedParticipant === OWNER_JID;
    }
  } catch (error) {
    logger.warn({ err: error }, 'Failed to normalize JID while checking owner');
  }

  return false;
}

async function imageToSticker(buffer) {
  return sharp(buffer)
    .resize(512, 512, {
      fit: 'inside',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .webp({ lossless: true })
    .toBuffer();
}

async function handleStickerCommand(sock, message) {
  const content = unwrapMessageContent(message);
  const imageMessage = content?.imageMessage;

  if (!imageMessage) {
    logger.info('Sticker command received without image payload');
    return;
  }

  try {
    logger.info({ remoteJid: message.key.remoteJid }, 'Downloading image for sticker');
    const mediaBuffer = await downloadMediaMessage(
      message,
      'buffer',
      {},
      { logger, reuploadRequest: sock }
    );

    const stickerBuffer = await imageToSticker(mediaBuffer);

    await sock.sendMessage(
      message.key.remoteJid,
      { sticker: stickerBuffer },
      { quoted: message }
    );

    logger.info({ remoteJid: message.key.remoteJid }, 'Sticker sent successfully');
  } catch (error) {
    logger.error({ err: error }, 'Failed to create sticker');
    await sock.sendMessage(
      message.key.remoteJid,
      { text: 'Maaf, stikernya gagal dibuat. Coba lagi ya!' },
      { quoted: message }
    );
  }
}

async function startBot() {
  try {
    logger.info('Starting WhatsApp bot');

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    logger.info({ version, isLatest }, 'Fetched WhatsApp Web version');

    const sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      browser: ['RailwayBot', 'Chrome', '1.0.0'],
      logger
    });

    sock.ev.on('creds.update', saveCreds);

    if (!state.creds?.registered) {
      try {
        const code = await sock.requestPairingCode(OWNER_NUMBER);
        console.log(`[PAIRING] Enter this code on your WhatsApp: ${code}`);
      } catch (error) {
        console.error('[PAIRING] Failed to generate pairing code err:', JSON.stringify(error, null, 2));
        await removeAuthFolder();
        process.exit(1);
      }
    }

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        logger.info('Connection to WhatsApp opened');
        return;
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode
          ?? lastDisconnect?.error?.output?.payload?.statusCode
          ?? lastDisconnect?.error?.statusCode;

        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

        if (isLoggedOut) {
          console.error('[AUTH] Session invalid, please restart the bot to pair again.');
          await removeAuthFolder();
          return;
        }

        logger.warn({ statusCode }, 'Connection closed, waiting for Baileys to reconnect');
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') {
        return;
      }

      for (const message of messages) {
        if (!message?.message) {
          continue;
        }

        if (!isFromOwner(message)) {
          logger.info({ remoteJid: message.key.remoteJid }, 'Ignoring message from non-owner');
          continue;
        }

        const content = unwrapMessageContent(message);
        const imageMessage = content?.imageMessage;
        const caption = imageMessage?.caption || '';

        if (imageMessage && isStickerCommand(caption)) {
          await handleStickerCommand(sock, message);
        }
      }
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to start the bot');
    await removeAuthFolder();
    process.exit(1);
  }
}

startBot().catch(async (error) => {
  logger.error({ err: error }, 'Unhandled error in bot runtime');
  await removeAuthFolder();
  process.exit(1);
});
