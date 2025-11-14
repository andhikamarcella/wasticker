import { webcrypto } from 'crypto';
global.crypto = webcrypto;

import fs from 'fs';
import { promises as fsPromises } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import baileys, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  downloadMediaMessage,
  DisconnectReason
} from '@whiskeysockets/baileys';

const { default: makeWASocket } = baileys;

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const logger = pino({ level: 'info' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const AUTH_FOLDER = join(__dirname, 'auth');
const OWNER_NUMBER = '6285163207556';
const OWNER_JID = jidNormalizedUser(`${OWNER_NUMBER}@s.whatsapp.net`);
const STICKER_COMMANDS = new Set(['!s', '!sticker']);
const RECONNECT_DELAY_MS = 5000;

async function removeAuthFolder() {
  if (fs.existsSync(AUTH_FOLDER)) {
    try {
      await fsPromises.rm(AUTH_FOLDER, { recursive: true, force: true });
      logger.warn('Removed auth folder after logout. Please restart the bot to pair again.');
    } catch (error) {
      logger.error({ err: error }, 'Failed to remove auth folder');
    }
  }
}

function isStickerCommand(caption = '') {
  const normalized = caption.trim().toLowerCase();
  return STICKER_COMMANDS.has(normalized);
}

function isMessageFromOwner(message) {
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

  return jidNormalizedUser(participant || remoteJid) === OWNER_JID;
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

async function handleStickerCommand(sock, message) {
  const content = unwrapMessageContent(message);

  if (!content?.imageMessage) {
    logger.info('Sticker command received without an image payload');
    return;
  }

  try {
    logger.info({ remoteJid: message.key.remoteJid }, 'Downloading image for sticker conversion');
    const mediaBuffer = await downloadMediaMessage(
      message,
      'buffer',
      {},
      { reuploadRequest: sock, logger }
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
      { text: 'Maaf, aku gagal bikin stikernya. Coba lagi ya!' },
      { quoted: message }
    );
  }
}

async function startBot() {
  try {
    logger.info('Starting WhatsApp sticker bot');

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    logger.info({ version, isLatest }, 'Fetched WhatsApp Web version information');

    const sock = makeWASocket({
      auth: state,
      version,
      browser: ['RailwayBot', 'Chrome', '108.0.5359.98'],
      printQRInTerminal: false,
      logger
    });

    sock.ev.on('creds.update', saveCreds);

    if (!state.creds?.registered) {
      try {
        const code = await sock.requestPairingCode(OWNER_NUMBER);
        console.log(`[PAIRING] Enter this code on your WhatsApp: ${code}`);
      } catch (error) {
        logger.error({ err: error }, 'Failed to generate pairing code');
      }
    }

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        logger.info('Connection to WhatsApp opened');
        return;
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        if (isLoggedOut) {
          logger.error({ statusCode }, 'Logged out from WhatsApp');
          await removeAuthFolder();
          return;
        }

        logger.warn({ statusCode }, 'Connection closed, attempting to reconnect');
        setTimeout(startBot, RECONNECT_DELAY_MS);
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

        if (!isMessageFromOwner(message)) {
          logger.info({ remoteJid: message.key.remoteJid }, 'Ignoring message from non-owner');
          continue;
        }

        const content = unwrapMessageContent(message);
        const imageMessage = content?.imageMessage;
        const caption = imageMessage?.caption || '';

        if (imageMessage && isStickerCommand(caption)) {
          await handleStickerCommand(sock, message);
        } else if (imageMessage) {
          logger.info('Owner sent image without sticker command, ignoring');
        } else {
          logger.info({ messageTypes: Object.keys(content || {}) }, 'Received non-image message from owner');
        }
      }
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to start the bot');
    setTimeout(startBot, RECONNECT_DELAY_MS);
  }
}

startBot().catch((error) => {
  logger.error({ err: error }, 'Unhandled error in bot runtime');
});
