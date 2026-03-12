const nodemailer = require("nodemailer");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const fs = require("fs");
const path = require("path");

const ACCOUNTS_FILE = path.join(__dirname, "mail_accounts.json");

class MailManager {
  constructor() {
    this.accounts = this.loadAccounts();
  }

  loadAccounts() {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      try {
        return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
      } catch (e) {
        console.error("Error loading mail accounts:", e);
        return {};
      }
    }
    return {};
  }

  saveAccounts() {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(this.accounts, null, 2));
  }

  addAccount(name, config) {
    // config: { host, port, secure, user, pass, type: 'smtp' | 'imap' }
    this.accounts[name] = config;
    this.saveAccounts();
    return `Account "${name}" added.`;
  }

  removeAccount(name) {
    if (this.accounts[name]) {
      delete this.accounts[name];
      this.saveAccounts();
      return `Account "${name}" removed.`;
    }
    return `Account "${name}" not found.`;
  }

  listAccounts() {
    return Object.keys(this.accounts);
  }

  async sendEmail(accountName, to, subject, text, html = null) {
    const config = this.accounts[accountName];
    if (!config || config.type !== 'smtp') throw new Error("Invalid SMTP account");

    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.user,
        pass: config.pass,
      },
    });

    const info = await transporter.sendMail({
      from: config.user,
      to,
      subject,
      text,
      html,
    });

    return info.messageId;
  }

  async withImap(accountName, callback) {
    const config = this.accounts[accountName];
    if (!config || config.type !== 'imap') throw new Error("Invalid IMAP account");

    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.user,
        pass: config.pass,
      },
      logger: false,
    });

    await client.connect();
    try {
      return await callback(client);
    } finally {
      await client.logout();
    }
  }

  async listFolders(accountName) {
    return await this.withImap(accountName, async (client) => {
      const folders = await client.list();
      return folders.map(f => f.path);
    });
  }

  async listMessages(accountName, folder = "INBOX", limit = 10) {
    return await this.withImap(accountName, async (client) => {
      let lock = await client.getMailboxLock(folder);
      try {
        const messages = [];
        // Fetch last 'limit' messages
        for await (let msg of client.fetch({ seq: `${Math.max(1, client.mailbox.exists - limit + 1)}:*` }, { envelope: true })) {
          messages.push({
            uid: msg.uid,
            seq: msg.seq,
            subject: msg.envelope.subject,
            from: msg.envelope.from ? msg.envelope.from[0].address : "Unknown",
            to: msg.envelope.to ? msg.envelope.to[0].address : "Unknown",
            date: msg.envelope.date,
          });
        }
        return messages.reverse();
      } finally {
        lock.release();
      }
    });
  }

  async listMessagesAll(accountName, folder = "INBOX", limit = 10) {
    return await this.withImap(accountName, async (client) => {
      let lock = await client.getMailboxLock(folder);
      try {
        const messages = [];
        // Fetch last 'limit' messages
        const range = `${Math.max(1, client.mailbox.exists - limit + 1)}:*`;
        for await (let msg of client.fetch({ seq: range }, { source: true })) {
          const parsed = await simpleParser(msg.source);
          messages.push({
            uid: msg.uid,
            seq: msg.seq,
            subject: parsed.subject,
            from: parsed.from.text,
            to: parsed.to.text,
            date: parsed.date,
            text: parsed.text,
            html: parsed.html,
          });
        }
        return messages.reverse();
      } finally {
        lock.release();
      }
    });
  }

  async getMessage(accountName, uid, folder = "INBOX", downloadAttachments = false) {
    return await this.withImap(accountName, async (client) => {
      let lock = await client.getMailboxLock(folder);
      try {
        const { content } = await client.download(uid, null, { uid: true });
        const parsed = await simpleParser(content);
        
        const result = {
          subject: parsed.subject,
          from: parsed.from.text,
          to: parsed.to.text,
          date: parsed.date,
          text: parsed.text,
          html: parsed.html,
          attachments: parsed.attachments.map(att => ({
            filename: att.filename,
            contentType: att.contentType,
            size: att.size,
            checksum: att.checksum
          }))
        };

        if (downloadAttachments && parsed.attachments.length > 0) {
          const tempDir = path.join(__dirname, "tmp");
          if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
          
          result.downloadedAttachments = parsed.attachments.map(att => {
            const filePath = path.join(tempDir, `${Date.now()}_${att.filename}`);
            fs.writeFileSync(filePath, att.content);
            return { filename: att.filename, path: filePath };
          });
        }

        return result;
      } finally {
        lock.release();
      }
    });
  }

  async deleteMessage(accountName, uid, folder = "INBOX") {
    return await this.withImap(accountName, async (client) => {
      let lock = await client.getMailboxLock(folder);
      try {
        await client.messageDelete(uid, { uid: true });
        return `Message ${uid} deleted.`;
      } finally {
        lock.release();
      }
    });
  }

  async moveMessage(accountName, uid, targetFolder, sourceFolder = "INBOX") {
    return await this.withImap(accountName, async (client) => {
      let lock = await client.getMailboxLock(sourceFolder);
      try {
        await client.messageMove(uid, targetFolder, { uid: true });
        return `Message ${uid} moved to ${targetFolder}.`;
      } finally {
        lock.release();
      }
    });
  }
}

module.exports = new MailManager();
