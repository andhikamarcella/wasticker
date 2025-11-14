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

const logger = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
  debug: (...args) => console.debug('[DEBUG]', ...args)
};

function normalizeOwnerNumber(rawNumber) {
  const digits = (rawNumber || '').replace(/\D/g, '');
  if (!digits) {
    return null;
  }
  return `${digits}@s.whatsapp.net`;
}

const ownerNumberRaw = process.env.OWNER_NUMBER;
const ownerJid = normalizeOwnerNumber(ownerNumberRaw);

if (!ownerJid) {
  logger.warn('OWNER_NUMBER environment variable is missing or invalid. The bot will ignore all messages.');
} else {
  logger.info('Owner JID loaded', { ownerJid });
}

async function createStickerFromImage(imageBuffer) {
  logger.debug('Creating sticker from image buffer');
  return sharp(imageBuffer)
    .resize(512, 512, {
      fit: 'inside',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .webp({ lossless: true })
    .toBuffer();
}

async function handleImageMessage(sock, message) {
  try {
    const remoteJid = message.key.remoteJid;
    logger.info('Downloading image message', { remoteJid });

    const mediaBuffer = await downloadMediaMessage(
      message,
      'buffer',
      {},
      { reuploadRequest: sock }
    );

    const stickerBuffer = await createStickerFromImage(mediaBuffer);

    await sock.sendMessage(
      remoteJid,
      { sticker: stickerBuffer },
      { quoted: message }
    );

    logger.info('Sticker sent successfully', { remoteJid });
  } catch (error) {
    logger.error('Failed to process image message', error);
  }
}

async function handleVideoMessage(sock, message) {
  const remoteJid = message.key.remoteJid;
  logger.info('Video message received, informing user', { remoteJid });
  try {
    await sock.sendMessage(
      remoteJid,
      { text: 'Untuk sekarang aku cuma bisa bikin stiker dari foto ya 😊' },
      { quoted: message }
    );
  } catch (error) {
    logger.error('Failed to reply to video message', error);
  }
}

function logNonMediaMessage(message) {
  const remoteJid = message.key.remoteJid;
  const messageTypes = Object.keys(message.message || {});
  logger.info('Non-media message received', { remoteJid, messageTypes });
}

async function startBot() {
  try {
    logger.info('Starting WhatsApp sticker bot');

    const { state, saveCreds } = await useMultiFileAuthState('auth');
    const { version, isLatest } = await fetchLatestBaileysVersion();

    logger.info('Using WhatsApp Web version', { version, isLatest });

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info('QR code received, please scan with WhatsApp');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        logger.info('Connection to WhatsApp opened');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logger.warn('Connection to WhatsApp closed', { statusCode, shouldReconnect });

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
        const remoteJid = message.key.remoteJid;
        const senderJid = message.key.participant || remoteJid;

        if (!message.message) {
          logger.debug('Skipping empty message payload', { remoteJid });
          continue;
        }

        if (message.key.fromMe) {
          logger.debug('Skipping message sent by the bot itself');
          continue;
        }

        if (!ownerJid || senderJid !== ownerJid) {
          logger.info('Ignoring message from non-owner', { senderJid, remoteJid });
          continue;
        }

        if (message.message.imageMessage) {
          await handleImageMessage(sock, message);
          continue;
        }

        if (message.message.videoMessage) {
          await handleVideoMessage(sock, message);
          continue;
        }

        logNonMediaMessage(message);
      }
    });
  } catch (error) {
    logger.error('Error while starting the bot', error);
    setTimeout(startBot, 5000);
  }
}

startBot().catch((error) => {
  logger.error('Fatal error occurred in bot runtime', error);
  process.exit(1);
});
