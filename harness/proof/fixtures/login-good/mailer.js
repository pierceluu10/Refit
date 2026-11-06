// Illustrative SMTP login with OAuth 2.0.
import nodemailer from 'nodemailer';
export const transport = nodemailer.createTransport({
  host: 'smtp.office365.com',
  port: 587,
  auth: { type: 'OAuth2', user: process.env.SMTP_USER, accessToken: process.env.SMTP_ACCESS_TOKEN },
});
