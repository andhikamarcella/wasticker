import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  extractVideoFrameToJpg,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import sharp from 'sharp';

const logger = pino({ level: 'info' });

async function createSticker(imageBuffer) {
  return sharp(imageBuffer)
    .resize(512, 512, {
      fit: 'inside',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .webp({ lossless: true, quality: 100 })
    .toBuffer();
}

async function processMediaMessage(sock, message, mediaType) {
  try {
    logger.info({ remoteJid: message.key.remoteJid, mediaType }, 'Downloading media message');
    const mediaBuffer = await downloadMediaMessage(
      message,
      'buffer',
      {},
      {
        logger,
        reuploadRequest: sock
      }
    );

    let imageBuffer = mediaBuffer;

    if (mediaType === 'video') {
      logger.info('Extracting frame from video');
      imageBuffer = await extractVideoFrameToJpg(mediaBuffer);
    }

    const stickerBuffer = await createSticker(imageBuffer);

    await sock.sendMessage(
      message.key.remoteJid,
      { sticker: stickerBuffer },
      { quoted: message }
    );

    logger.info('Sticker sent successfully');
  } catch (error) {
    logger.error({ err: error }, 'Failed to process media message');
  }
}

async function startBot() {
  try {
    logger.info('Initializing WhatsApp Sticker Bot');

    const { state, saveCreds } = await useMultiFileAuthState('auth');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info({ version, isLatest }, 'WhatsApp Web version info');

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info('QR code received, scan with WhatsApp');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        logger.info('WhatsApp connection opened');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        logger.warn({ statusCode }, 'WhatsApp connection closed');

        if (shouldReconnect) {
          logger.info('Reconnecting to WhatsApp...');
          setTimeout(startBot, 2000);
        } else {
          logger.error('Logged out from WhatsApp. Delete the auth folder and restart to log in again.');
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') {
        return;
      }

      for (const message of messages) {
        if (!message.message) {
          logger.debug({ remoteJid: message.key.remoteJid }, 'Received empty message payload');
          continue;
        }

        const isImage = Boolean(message.message.imageMessage);
        const isVideo = Boolean(message.message.videoMessage);

        if (!isImage && !isVideo) {
          logger.info({ remoteJid: message.key.remoteJid }, 'Non-media message received, ignoring');
          continue;
        }

        const mediaType = isImage ? 'image' : 'video';
        await processMediaMessage(sock, message, mediaType);
      }
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to start bot');
    setTimeout(startBot, 5000);
  }
}

startBot().catch((error) => {
  logger.error({ err: error }, 'Fatal error in bot runtime');
  process.exit(1);
});
