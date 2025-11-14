import { webcrypto } from 'node:crypto';

globalThis.crypto = webcrypto;

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import makeWASocketPkg, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  downloadMediaMessage
} from '@whiskeysockets/baileys';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import pino from 'pino';
import sharp from 'sharp';
import qrcode from 'qrcode-terminal';

const { default: makeWASocket } = makeWASocketPkg;

ffmpeg.setFfmpegPath(ffmpegStatic);

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const AUTH_FOLDER = 'auth';
const COMMAND_ALIASES = new Set(['!sticker', '!s']);
const MAX_VIDEO_DURATION = 10; // seconds
const RECONNECT_DELAY_MS = 5000;
const SHOULD_PRINT_QR = process.env.ENABLE_QR === '1';

const rawOwnerNumber = process.env.OWNER_NUMBER || '6285163207556';
const ownerDigits = rawOwnerNumber.replace(/\D/g, '');
let ownerJid = null;

if (!ownerDigits) {
  logger.warn(
    '[WARN] OWNER_NUMBER environment variable is missing or invalid. The bot will still run but no owner-only commands will be allowed.'
  );
} else {
  try {
    ownerJid = jidNormalizedUser(`${ownerDigits}@s.whatsapp.net`);
    logger.info({ ownerJid }, 'Owner JID configured');
  } catch (error) {
    ownerJid = null;
    logger.error({ err: error }, 'Failed to normalize owner JID');
  }
}

function isOwnerMessage(message) {
  if (message.key.fromMe) {
    return true;
  }

  if (!ownerJid) {
    return false;
  }

  const remote = message.key.remoteJid ? jidNormalizedUser(message.key.remoteJid) : null;
  const participant = message.key.participant ? jidNormalizedUser(message.key.participant) : null;

  return remote === ownerJid || participant === ownerJid;
}

async function cleanupAuthFolder() {
  try {
    await fs.rm(AUTH_FOLDER, { recursive: true, force: true });
    logger.info('Auth folder removed. Please restart the bot to authenticate again.');
  } catch (error) {
    logger.error({ err: error }, 'Failed to remove auth folder');
  }
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

async function videoToSticker(buffer) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wasticker-'));
  const inputPath = path.join(tempDir, 'input');
  const outputPath = path.join(tempDir, 'output.webp');

  await fs.writeFile(inputPath, buffer);

  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .inputOptions(['-t 10'])
      .outputOptions([
        '-vf',
        'scale=512:512:force_original_aspect_ratio=decrease,fps=15,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
        '-loop',
        '0',
        '-an',
        '-vsync',
        '0'
      ])
      .toFormat('webp')
      .save(outputPath)
      .on('end', resolve)
      .on('error', reject);
  });

  const sticker = await fs.readFile(outputPath);
  await fs.rm(tempDir, { recursive: true, force: true });
  return sticker;
}

function extractCaption(message) {
  const imageMessage = message.message?.imageMessage;
  if (imageMessage?.caption) {
    return imageMessage.caption.trim();
  }

  const videoMessage = message.message?.videoMessage;
  if (videoMessage?.caption) {
    return videoMessage.caption.trim();
  }

  return message.message?.conversation?.trim() || null;
}

function hasCommand(caption) {
  if (!caption) {
    return false;
  }

  const [command] = caption.toLowerCase().split(/\s+/);
  return COMMAND_ALIASES.has(command);
}

async function handleStickerCommand(sock, message) {
  const remoteJid = message.key.remoteJid;

  try {
    if (message.message?.imageMessage) {
      logger.info({ remoteJid }, 'Processing image sticker request');
      const mediaBuffer = await downloadMediaMessage(
        message,
        'buffer',
        {},
        { logger, reuploadRequest: sock }
      );
      const sticker = await imageToSticker(mediaBuffer);
      await sock.sendMessage(remoteJid, { sticker }, { quoted: message });
      logger.info({ remoteJid }, 'Image sticker sent');
      return;
    }

    if (message.message?.videoMessage) {
      const duration = message.message.videoMessage.seconds || 0;
      if (duration > MAX_VIDEO_DURATION) {
        logger.warn({ remoteJid, duration }, 'Video too long for sticker conversion');
        await sock.sendMessage(
          remoteJid,
          { text: 'Maaf, videonya terlalu panjang. Kirim video maksimal 10 detik ya.' },
          { quoted: message }
        );
        return;
      }

      logger.info({ remoteJid }, 'Processing video sticker request');
      const mediaBuffer = await downloadMediaMessage(
        message,
        'buffer',
        {},
        { logger, reuploadRequest: sock }
      );
      const sticker = await videoToSticker(mediaBuffer);
      await sock.sendMessage(remoteJid, { sticker }, { quoted: message });
      logger.info({ remoteJid }, 'Video sticker sent');
      return;
    }

    logger.info({ remoteJid }, 'Command received without supported media');
    await sock.sendMessage(
      remoteJid,
      { text: 'Kirim foto atau video pendek dengan caption !sticker atau !s ya.' },
      { quoted: message }
    );
  } catch (error) {
    logger.error({ err: error, remoteJid }, 'Failed to create sticker');
    await sock.sendMessage(
      remoteJid,
      { text: 'Maaf, aku gagal bikin stikernya. Coba lagi ya!' },
      { quoted: message }
    );
  }
}

async function startBot() {
  logger.info('Starting WhatsApp sticker bot');

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info({ version, isLatest }, 'Using WhatsApp Web version');

    const sock = makeWASocket({
      version,
      auth: state,
      logger: logger.child({ module: 'baileys' }),
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '22.04', '1.0.0']
    });

    if (!state.creds?.registered && ownerDigits) {
      try {
        const pairingCode = await sock.requestPairingCode(ownerDigits);
        logger.info({ pairingCode }, '[PAIRING] Your WhatsApp pairing code');
      } catch (error) {
        logger.error({ err: error }, 'Failed to generate pairing code');
      }
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && SHOULD_PRINT_QR) {
        qrcode.generate(qr, { small: true });
        logger.info('[DEBUG] QR code printed to terminal');
      }

      if (connection === 'open') {
        logger.info('[INFO] Connection to WhatsApp opened');
        return;
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
        const reason = statusCode ?? lastDisconnect?.error;

        logger.warn({ statusCode, reason }, 'Connection closed');

        if (statusCode === DisconnectReason.loggedOut) {
          logger.error('[ERROR] Logged out, please delete auth folder and restart.');
          await cleanupAuthFolder();
          return;
        }

        logger.info({ delay: RECONNECT_DELAY_MS }, 'Reconnecting to WhatsApp');
        setTimeout(startBot, RECONNECT_DELAY_MS);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') {
        return;
      }

      for (const message of messages) {
        if (!message.message) {
          continue;
        }

        if (!isOwnerMessage(message)) {
          logger.info(
            {
              remoteJid: message.key.remoteJid,
              participant: message.key.participant
            },
            '[INFO] Ignoring message from non-owner'
          );
          continue;
        }

        const caption = extractCaption(message);
        const hasMedia = Boolean(message.message.imageMessage || message.message.videoMessage);

        if (hasMedia && hasCommand(caption)) {
          await handleStickerCommand(sock, message);
          continue;
        }

        if (message.message.videoMessage && !hasCommand(caption)) {
          await sock.sendMessage(
            message.key.remoteJid,
            { text: 'Untuk sekarang aku cuma bisa bikin stiker dari foto ya 😊' },
            { quoted: message }
          );
          continue;
        }

        logger.info(
          {
            remoteJid: message.key.remoteJid,
            messageTypes: Object.keys(message.message)
          },
          'Received non-command message from owner'
        );
      }
    });
  } catch (error) {
    logger.error({ err: error }, '[ERROR] Error while starting the bot');
    setTimeout(startBot, RECONNECT_DELAY_MS);
  }
}

startBot().catch((error) => {
  logger.error({ err: error }, '[ERROR] Unexpected failure in bot runtime');
});
