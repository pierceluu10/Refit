// Illustrative SMTP login with a password.
import nodemailer from 'nodemailer';
export const transport = nodemailer.createTransport({
  host: 'smtp.office365.com',
  port: 587,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});
