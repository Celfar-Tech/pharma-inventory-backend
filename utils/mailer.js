const nodemailer = require("nodemailer");
// 1. Configure your email transporter
const transporter = nodemailer.createTransport({
  host: "smtpout.secureserver.net",
  port: 465,
  secure: true, // Must be true for port 465
  auth: {
    user: process.env.EMAIL_USER,        
    pass: process.env.EMAIL_APP_PASSWORD,
  },
});
// 2. Export the sendOtpEmail function
const sendOtpEmail = async (toEmail, otp) => {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: toEmail,
    subject: "PharmaConnect - Email Verification Code",
    html: `
      <div style="font-family: Arial, sans-serif; padding: 24px; background-color: #f8fafc; border-radius: 8px; color: #1e293b;">
        <h2 style="color: #0284c7; margin-top: 0;">Welcome to PharmaConnect</h2>
        <p style="font-size: 16px;">Please use the verification code below to proceed with your registration:</p>
        <div style="background: #ffffff; padding: 16px 24px; border-radius: 6px; display: inline-block; border: 1px solid #e2e8f0; margin: 16px 0;">
          <span style="font-size: 28px; font-weight: bold; letter-spacing: 4px; color: #0284c7;">${otp}</span>
        </div>
        <p style="font-size: 14px; color: #64748b;">This code will expire in 10 minutes.</p>
        <p style="font-size: 12px; color: #94a3b8; margin-top: 24px;">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
};

module.exports = { sendOtpEmail };