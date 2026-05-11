/**
 * Email Service — Password Reset
 *
 * Sends transactional emails via nodemailer.
 *
 * Strategy (in priority order):
 *   1. Real SMTP  — if SMTP_HOST / SMTP_USER / SMTP_PASS are set in .env
 *                   and not the placeholder values → sends real email
 *   2. Ethereal   — auto-creates a free test inbox (ethereal.email) and
 *                   prints a clickable preview URL to the terminal.
 *                   Zero setup needed — works out of the box for development.
 *
 * Real Gmail setup (optional, for production-like testing):
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=587
 *   SMTP_USER=your@gmail.com
 *   SMTP_PASS=xxxx xxxx xxxx xxxx   ← 16-char App Password from
 *                                      https://myaccount.google.com/apppasswords
 *   SMTP_FROM=AutoTest AI <your@gmail.com>
 */
import nodemailer from 'nodemailer'
import { createModuleLogger } from '../logger/index.js'

const log = createModuleLogger('email')

// ── Detect placeholder values ─────────────────────────────────────────────────
function isPlaceholder(val: string | undefined): boolean {
  if (!val) return true
  return (
    val.includes('your_gmail') ||
    val.includes('your_16_char') ||
    val === 'your@gmail.com'
  )
}

function isRealSmtpConfigured(): boolean {
  return (
    !isPlaceholder(process.env.SMTP_HOST) &&
    !isPlaceholder(process.env.SMTP_USER) &&
    !isPlaceholder(process.env.SMTP_PASS)
  )
}

// ── Cached transporter (real or Ethereal) ────────────────────────────────────
let _transporter: nodemailer.Transporter | null = null
let _transporterFrom = ''
let _usingEthereal = false

async function getTransporter(): Promise<{ transport: nodemailer.Transporter; from: string; ethereal: boolean }> {
  if (_transporter) {
    return { transport: _transporter, from: _transporterFrom, ethereal: _usingEthereal }
  }

  if (isRealSmtpConfigured()) {
    // ── Real SMTP ──────────────────────────────────────────────────────────
    const host = process.env.SMTP_HOST!
    const port = parseInt(process.env.SMTP_PORT ?? '587', 10)
    const user = process.env.SMTP_USER!
    const pass = process.env.SMTP_PASS!
    const from = process.env.SMTP_FROM ?? `AutoTest AI <${user}>`

    _transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    })
    _transporterFrom = from
    _usingEthereal = false

    log.info(`[EMAIL] Using real SMTP: ${host}:${port} as ${user}`)
    return { transport: _transporter, from, ethereal: false }
  }

  // ── Ethereal fallback — auto-create test account ───────────────────────────
  log.warn('[EMAIL] Real SMTP not configured — using Ethereal test inbox (emails visible at ethereal.email)')

  const testAccount = await nodemailer.createTestAccount()

  _transporter = nodemailer.createTransport({
    host: 'smtp.ethereal.email',
    port: 587,
    secure: false,
    auth: {
      user: testAccount.user,
      pass: testAccount.pass,
    },
  })
  _transporterFrom = `AutoTest AI <${testAccount.user}>`
  _usingEthereal = true

  log.info(`[EMAIL] Ethereal test account created: ${testAccount.user}`)
  return { transport: _transporter, from: _transporterFrom, ethereal: true }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface SendResetEmailOptions {
  toEmail: string
  identifier: string
  token: string
  expiresInMin: number
}

/**
 * Send a password-reset email.
 * Always succeeds in dev (Ethereal fallback).
 * Returns true on success, false if something unexpected fails.
 */
export async function sendPasswordResetEmail(opts: SendResetEmailOptions): Promise<boolean> {
  let transporter: nodemailer.Transporter
  let from: string
  let ethereal: boolean

  try {
    const result = await getTransporter()
    transporter = result.transport
    from = result.from
    ethereal = result.ethereal
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error(`[EMAIL] Failed to create transporter: ${msg}`)
    return false
  }

  const html = buildHtmlEmail(opts)
  const text = buildTextEmail(opts)

  try {
    const info = await transporter.sendMail({
      from,
      to: opts.toEmail,
      subject: '🔐 AutoTest AI — Password Reset Token',
      text,
      html,
    })

    if (ethereal) {
      const previewUrl = nodemailer.getTestMessageUrl(info)
      // ── Print preview URL prominently so the developer can click it ────────
      console.log('\n[EMAIL] ══════════════════════════════════════════════════')
      console.log('[EMAIL]  📧 PASSWORD RESET EMAIL (Ethereal test inbox)')
      console.log(`[EMAIL]  To      : ${opts.toEmail}`)
      console.log(`[EMAIL]  Account : ${opts.identifier}`)
      console.log(`[EMAIL]  Token   : ${opts.token}`)
      console.log(`[EMAIL]  Preview : ${previewUrl}`)
      console.log('[EMAIL]  ↑ Click the link above to view the email in browser')
      console.log('[EMAIL] ══════════════════════════════════════════════════\n')
      log.info(`[EMAIL] Ethereal preview URL: ${previewUrl}`)
    } else {
      log.info(`[EMAIL] ✉️  Reset email sent to ${opts.toEmail} (messageId: ${info.messageId})`)
      console.log(`\n[EMAIL] ✅ Password reset email sent to ${opts.toEmail}\n`)
    }

    return true
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error({ err }, `[EMAIL] Failed to send email to ${opts.toEmail}: ${msg}`)
    return false
  }
}

// ── Email templates ───────────────────────────────────────────────────────────

function buildHtmlEmail(opts: SendResetEmailOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Password Reset — AutoTest AI</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:system-ui,-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:40px 0;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.09);">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#4f46e5 0%,#2563eb 100%);padding:32px 40px;text-align:center;">
            <h1 style="margin:0;color:#fff;font-size:26px;font-weight:700;letter-spacing:-0.5px;">AutoTest AI</h1>
            <p style="margin:6px 0 0;color:rgba(255,255,255,0.75);font-size:13px;">Intelligent No-Code Test Automation</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:36px 40px;">
            <h2 style="margin:0 0 10px;font-size:20px;font-weight:700;color:#111827;">Password Reset Request</h2>
            <p style="margin:0 0 24px;color:#4b5563;font-size:14px;line-height:1.65;">
              We received a request to reset the password for account
              <strong style="color:#111827;">${opts.identifier}</strong>.
              Use the token below to complete your reset.
            </p>

            <!-- Token box -->
            <div style="background:#f0f4ff;border:2px dashed #6366f1;border-radius:12px;padding:22px 28px;text-align:center;margin-bottom:28px;">
              <p style="margin:0 0 8px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#6b7280;">Your Reset Token</p>
              <code style="display:block;font-family:'Courier New',monospace;font-size:13px;color:#1d4ed8;word-break:break-all;line-height:1.6;font-weight:700;">${opts.token}</code>
              <p style="margin:10px 0 0;font-size:12px;color:#9ca3af;">⏱ Expires in <strong>${opts.expiresInMin} minutes</strong></p>
            </div>

            <!-- Steps -->
            <div style="background:#f9fafb;border-radius:10px;padding:18px 22px;margin-bottom:24px;">
              <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#374151;">How to reset your password:</p>
              <table cellpadding="0" cellspacing="0">
                ${['Go to the AutoTest AI login page', 'Click <strong>Forgot password?</strong>', 'Paste the token above and enter a new password'].map((step, i) => `
                <tr>
                  <td style="padding:4px 12px 4px 0;vertical-align:top;">
                    <div style="width:22px;height:22px;background:#4f46e5;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700;text-align:center;line-height:22px;">${i + 1}</div>
                  </td>
                  <td style="padding:4px 0;font-size:13px;color:#4b5563;line-height:1.5;">${step}</td>
                </tr>`).join('')}
              </table>
            </div>

            <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">
              If you did not request a password reset, you can safely ignore this email.<br/>
              Your password will not change until you use the token above.
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 40px;text-align:center;">
            <p style="margin:0;font-size:12px;color:#9ca3af;">
              © ${new Date().getFullYear()} AutoTest AI &nbsp;·&nbsp; Do not reply to this email.
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`
}

function buildTextEmail(opts: SendResetEmailOptions): string {
  return `AutoTest AI — Password Reset

A reset was requested for account: ${opts.identifier}

Reset Token:
${opts.token}

Expires in: ${opts.expiresInMin} minutes

Steps:
1. Go to the AutoTest AI login page
2. Click "Forgot password?"
3. Paste the token above and set a new password

If you did not request this, ignore this email.

© ${new Date().getFullYear()} AutoTest AI`
}
