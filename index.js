import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  extractVideoFrameToJpg,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import sharp from 'sharp';

const logger = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
  debug: (...args) => console.debug('[DEBUG]', ...args)
};

async function createSticker(imageBuffer) {
  return sharp(imageBuffer)
    .resize(512, 512, {
      fit: 'inside',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .webp({ lossless: true })
    .toBuffer();
}

async function processMediaMessage(sock, message, mediaType) {
  try {
    logger.info('Downloading media message', { remoteJid: message.key.remoteJid, mediaType });
    const mediaBuffer = await downloadMediaMessage(
      message,
      'buffer',
      {},
      {
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
    logger.error('Failed to process media message', error);
  }
}

async function startBot() {
  try {
    logger.info('Initializing WhatsApp Sticker Bot');

    const { state, saveCreds } = await useMultiFileAuthState('auth');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info('WhatsApp Web version info', { version, isLatest });

    const sock = makeWASocket({
      version,
      auth: state,
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
        logger.warn('WhatsApp connection closed', { statusCode });

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
          logger.debug('Received empty message payload', { remoteJid: message.key.remoteJid });
          continue;
        }

        const isImage = Boolean(message.message.imageMessage);
        const isVideo = Boolean(message.message.videoMessage);

        if (!isImage && !isVideo) {
          logger.info('Non-media message received, ignoring', { remoteJid: message.key.remoteJid });
          continue;
        }

        const mediaType = isImage ? 'image' : 'video';
        await processMediaMessage(sock, message, mediaType);
      }
    });
  } catch (error) {
    logger.error('Failed to start bot', error);
    setTimeout(startBot, 5000);
  }
}

startBot().catch((error) => {
  logger.error('Fatal error in bot runtime', error);
  process.exit(1);
});
