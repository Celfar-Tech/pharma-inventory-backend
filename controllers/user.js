const bcrypt = require("bcrypt");
const validate = require("validator");
const User = require("../models/user");
const createToken = require("../token");
const { sendOtpEmail } = require("../utils/mailer");
const crypto = require('crypto');

const passwordResetSessions = new Map();

// Session lifetime shared by every cookie issued on a successful sign-in.
const SESSION_MAX_AGE = 14 * 60 * 60 * 1000;

/**
 * Google OAuth client IDs whose ID tokens we accept. More than one can be
 * supplied (comma separated) so dev and prod origins can each have their own
 * client; the default keeps the app working without extra configuration.
 */
const GOOGLE_CLIENT_IDS = (
  process.env.GOOGLE_CLIENT_IDS ||
  '423042807905-23145tagvsevp6621bgtu465d2ecp2pd.apps.googleusercontent.com'
)
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// Roles a user may self-provision. Anything outside this list falls back to
// `pharmacist`, so a tampered request can never mint an elevated account.
const SELF_SERVICE_ROLES = ['pharmacist', 'doctor'];

const normalizeRole = (role) => (SELF_SERVICE_ROLES.includes(role) ? role : 'pharmacist');

/**
 * Writes the session cookies every authenticated request depends on.
 * Extracted so password login and Google login cannot drift apart.
 */
const setSessionCookies = (res, token, userData) => {
  res.cookie('has_session', 'true', {
    httpOnly: false, // React CAN read this to know a session exists
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
  res.cookie('token', token, {
    httpOnly: true, // Prevents JavaScript (XSS attacks) from reading the cookie
    secure: process.env.NODE_ENV === 'production', // Use HTTPS in production
    sameSite: 'lax', // Protects against CSRF attacks ('strict' or 'lax')
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
  res.cookie('user', JSON.stringify(userData), {
    httpOnly: false, // Allows the frontend to read user details from the cookie when needed
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
};

/**
 * Verifies a Google ID token (the `credential` returned by Google Identity
 * Services) via Google's tokeninfo endpoint and returns its claims.
 *
 * tokeninfo validates the signature, issuer and expiry; we additionally check
 * `aud` (so a token minted for another app is rejected) and `email_verified`
 * (so an unverified Google address can never claim an existing account).
 */
const verifyGoogleCredential = async (credential) => {
  const response = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`,
  );

  if (!response.ok) {
    throw new Error('Invalid Google credential.');
  }

  const payload = await response.json();

  if (!GOOGLE_CLIENT_IDS.includes(payload.aud)) {
    throw new Error('Google credential was not issued for this application.');
  }

  if (payload.email_verified !== 'true' && payload.email_verified !== true) {
    throw new Error('Your Google email address is not verified.');
  }

  return payload;
};

/** Derives a unique username from an email address, e.g. `jane.doe@x.com` -> `janedoe`. */
const buildUniqueUsername = async (email) => {
  const base =
    String(email)
      .split('@')[0]
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 24) || 'user';

  let candidate = base;
  let suffix = 0;

  // `username` is unique in the schema, so probe until a free one is found.
  while (await User.findByUsername(candidate)) {
    suffix += 1;
    candidate = `${base}${suffix}`;
  }

  return candidate;
};

const createOtpToken = (email, otp, expiresAt) => {
  const sanitizedEmail = String(email || '').trim().toLowerCase();
  const dataToHash = `${sanitizedEmail}.${otp}.${expiresAt}`;
  const hash = crypto
    .createHmac('sha256', process.env.OTP_SECRET || 'fallback_development_secret')
    .update(dataToHash)
    .digest('hex');

  return `${hash}.${expiresAt}`;
};

const validateOtpToken = (email, otp, token) => {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { valid: false, error: 'Verification session missing or expired. Please request a new code.' };
  }

  const [originalHash, expiresAt] = token.split('.');
  const parsedExpiresAt = Number(expiresAt);

  if (Number.isNaN(parsedExpiresAt) || Date.now() > parsedExpiresAt) {
    return { valid: false, error: 'Code expired. Please request a new one.' };
  }

  const expectedToken = createOtpToken(email, otp, parsedExpiresAt);
  const expectedHash = expectedToken.split('.')[0];

  if (originalHash !== expectedHash) {
    return { valid: false, error: 'Incorrect verification code.' };
  }

  return { valid: true, expiresAt: parsedExpiresAt };
};

exports.signUp = async (req, res, next) => {
  // 🌟 Extracted role from incoming request body
  const { role = "pharmacist", username, fullname, email, password } = req.body;

  // Initial field validation including role
  if (!(username && fullname && email && password)) {
    console.error("Validation Error: All fields are mandatory");
    return res.status(200).json({ success: false, error: "All fields are mandatory" });
  }

  if (!validate.isEmail(email)) {
    console.error("Validation Error: Invalid Email");
    return res.status(200).json({ success: false, error: "Invalid Email format" });
  }

  if (!validate.isStrongPassword(password)) {
    console.error("Validation Error: Weak Password");
    return res.status(200).json({
      success: false,
      error: "Password must be at least 8 characters long and include uppercase, lowercase, numbers, and symbols."
    });
  }

  try {
    // Encrypt password
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);

    // 🌟 Instantiated User model passing role as the first parameter
    const new_user = new User(role, fullname, username, email, hash);
    const savedUser = await new_user.create_user(); // Returns { id, username, email, role }

    // Issue JWT token using properties returned from database
    const token = createToken(savedUser.id, savedUser.username, savedUser.email);

    return res.status(200).json({ username: savedUser.username, token: token });

  } catch (err) {
    console.error("Signup Catch Block Error:", err);

    // Catch unique violations from Postgres (username or email duplicate)
    if (err.code === "23505") {
      return res.status(200).json({ success: false, error: "Username or Email already exists." });
    }
    return res.status(500).json({ error: "Internal server registration error" });
  }
};

exports.logIn = async (req, res, next) => {
  const { email, password } = req.body;

  if (!(email && password)) {
    console.error("Validation Error: Missing credentials");
    return res.status(200).json({ success: false, error: "All fields are mandatory" });
  }

  if (!validate.isEmail(email)) {
    return res.status(200).json({ success: false, error: "Invalid Email format" });
  }

  try {
    const user = await User.findOne(email);

    if (!user) {
      return res.status(200).json({ success: false, error: "No account with that email found" });
    }

    const match = await bcrypt.compare(password, user.password);

    if (!match) {
      return res.status(200).json({ success: false, error: "Incorrect password" });
    }

    await User.logged_in(email);

    const token = createToken(user.id, user.username, email);
    const userData = { username: user.username, email: user.email, role: user.role };
    setSessionCookies(res, token, userData);

    return res.status(200).json({
      success: true,
      user: userData,
    });

  } catch (err) {
    console.error("Login Error:", err);
    return res.status(500).json({ error: "Internal server login error" });
  }
};

/**
 * Sign in (or sign up) with Google.
 *
 * The frontend sends the ID token returned by Google Identity Services; we
 * verify it, find-or-create the matching account and open the very same cookie
 * session the password login uses. Accounts are linked by email, so a user who
 * registered with a password can later sign in with Google too.
 */
exports.googleAuth = async (req, res) => {
  const { credential } = req.body || {};

  if (!credential || typeof credential !== 'string') {
    return res.status(200).json({ success: false, error: 'Google credential is required.' });
  }

  try {
    const payload = await verifyGoogleCredential(credential);
    const email = String(payload.email || '').trim().toLowerCase();

    if (!validate.isEmail(email)) {
      return res.status(200).json({
        success: false,
        error: 'Google account did not return a valid email address.',
      });
    }

    let user = await User.findOne(email);

    if (!user) {
      // Google users never choose an app password, so store an unguessable
      // random hash. This keeps the column NOT NULL while making password
      // login impossible for the account.
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), salt);

      const fullname =
        payload.name ||
        [payload.given_name, payload.family_name].filter(Boolean).join(' ') ||
        email.split('@')[0];
      const username = await buildUniqueUsername(email);

      const newUser = new User(normalizeRole(req.body?.role), fullname, username, email, hash);
      user = await newUser.create_user();
    }

    await User.logged_in(email);

    const token = createToken(user.id, user.username, email);
    const userData = { username: user.username, email: user.email, role: user.role };
    setSessionCookies(res, token, userData);

    return res.status(200).json({ success: true, user: userData });
  } catch (err) {
    console.error('Google auth error:', err);
    return res.status(200).json({
      success: false,
      error: err.message || 'Google sign-in failed. Please try again.',
    });
  }
};
exports.logOut = (req, res) => {
  res.clearCookie('has_session');
  // The client-readable `user` cookie is set at login, so it must be cleared
  // here too — otherwise it outlives the session it describes.
  res.clearCookie('user');
  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  });
  res.clearCookie('user');
  return res.status(200).json({ success: true, message: "Logged out successfully" });
};

exports.getProfile = (req, res) => {
  const {
    id,
    username,
    email,
    role,
    first_name,
    last_name,
    phone_number,
    license_number,
    status,
  } = req.user;

  return res.status(200).json({
    success: true,
    user: {
      id,
      username,
      email,
      role,
      first_name,
      last_name,
      phone_number,
      license_number,
      status,
    },
  });
};

// File: backend/controllers/user.js [BACKEND]

exports.sendOtp = async (req, res) => {
  const { email } = req.body;

  try {
    if (!email || typeof email !== 'string') {
      return res.status(200).json({
        success: false,
        error: "Email address is required."
      });
    }
    const sanitizedEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(sanitizedEmail)) {
      return res.status(200).json({
        success: false,
        error: "Please enter a valid email address."
      });
    }
    // 1. Check if user already exists
    const existingUser = await User.findOne(sanitizedEmail);
    if (existingUser) {
      return res.status(200).json({ success: false, error: "Email already registered" });
    }

    // 2. Generate a secure 6-digit OTP string
    const otp = require("crypto").randomInt(100000, 1000000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 🌟 Set to 10 minutes to match your mailer HTML description
    const dataToHash = `${sanitizedEmail}.${otp}.${expiresAt}`;
    const hash = crypto
      .createHmac('sha256', process.env.OTP_SECRET || 'fallback_development_secret')
      .update(dataToHash)
      .digest('hex');

    // Combine hash and expiration to send to frontend
    const verificationToken = `${hash}.${expiresAt}`;

    // 5. Trigger Mailer
    await sendOtpEmail(sanitizedEmail, otp);

    // 6. Return token to frontend (it holds the state, not the server!)
    return res.status(200).json({
      success: true,
      message: "OTP sent successfully!",
      token: verificationToken // 🌟 Frontend will store this in state
    });

  } catch (err) {
    console.error("Backend OTP Error:", err);
    return res.status(200).json({
      success: false,
      error: "Failed to process verification request. Please try again."
    });
  }
};
exports.verifyOtp = async (req, res) => {
  const { email, otp, token } = req.body;

  try {
    if (!email || !otp) {
      return res.status(200).json({
        success: false,
        error: "Email and OTP code are required."
      });
    }

    const sanitizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const validation = validateOtpToken(sanitizedEmail, otp, token);

    if (!validation.valid) {
      return res.status(200).json({
        success: false,
        error: validation.error
      });
    }

    return res.status(200).json({
      success: true,
      message: "Email verified successfully."
    });

  } catch (err) {
    console.error("Backend Verification Error:", err);
    return res.status(200).json({
      success: false,
      error: "Verification failed due to a server error."
    });
  }
};

exports.requestPasswordResetOtp = async (req, res) => {
  const { email } = req.body;

  try {
    if (!email || typeof email !== 'string') {
      return res.status(200).json({
        success: false,
        error: 'Email address is required.'
      });
    }

    const sanitizedEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(sanitizedEmail)) {
      return res.status(200).json({
        success: false,
        error: 'Please enter a valid email address.'
      });
    }

    const existingUser = await User.findOne(sanitizedEmail);
    if (!existingUser) {
      return res.status(200).json({
        success: false,
        error: 'No account with that email found.'
      });
    }

    const otp = require('crypto').randomInt(100000, 1000000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const token = createOtpToken(sanitizedEmail, otp, expiresAt);

    passwordResetSessions.set(sanitizedEmail, {
      otp,
      token,
      expiresAt,
      verified: false,
    });

    await sendOtpEmail(sanitizedEmail, otp);

    return res.status(200).json({
      success: true,
      message: 'Password reset code sent successfully.',
      token,
    });
  } catch (err) {
    console.error('Password reset OTP request error:', err);
    return res.status(200).json({
      success: false,
      error: 'Failed to process password reset request. Please try again.'
    });
  }
};

exports.verifyPasswordResetOtp = async (req, res) => {
  const { email, otp, token } = req.body;

  try {
    if (!email || !otp) {
      return res.status(200).json({
        success: false,
        error: 'Email and OTP code are required.'
      });
    }

    const sanitizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const storedSession = passwordResetSessions.get(sanitizedEmail);

    if (!storedSession) {
      return res.status(200).json({
        success: false,
        error: 'Verification session missing or expired. Please request a new code.'
      });
    }

    const validation = validateOtpToken(sanitizedEmail, otp, token);
    if (!validation.valid) {
      return res.status(200).json({
        success: false,
        error: validation.error,
      });
    }

    if (storedSession.token !== token || storedSession.otp !== otp) {
      return res.status(200).json({
        success: false,
        error: 'Incorrect verification code.'
      });
    }

    passwordResetSessions.set(sanitizedEmail, {
      ...storedSession,
      verified: true,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    return res.status(200).json({
      success: true,
      message: 'Recovery code verified successfully.',
      token: storedSession.token,
    });
  } catch (err) {
    console.error('Password reset OTP verification error:', err);
    return res.status(200).json({
      success: false,
      error: 'Verification failed due to a server error.'
    });
  }
};

exports.resetPassword = async (req, res) => {
  const { email, password, token } = req.body;

  try {
    if (!email || !password || !token) {
      return res.status(200).json({
        success: false,
        error: 'Email, new password, and verification token are required.'
      });
    }

    const sanitizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const storedSession = passwordResetSessions.get(sanitizedEmail);

    if (!storedSession || !storedSession.verified || storedSession.token !== token) {
      return res.status(200).json({
        success: false,
        error: 'Verification session missing or expired. Please restart the password reset flow.'
      });
    }

    if (typeof password !== 'string' || password.length < 6) {
      return res.status(200).json({
        success: false,
        error: 'Password must be at least 6 characters long.'
      });
    }

    const userExists = await User.findOne(sanitizedEmail);
    if (!userExists) {
      return res.status(200).json({
        success: false,
        error: 'No account with that email found.'
      });
    }
    const user = await User.findOne(email);
    const match = await bcrypt.compare(password, user.password);
    if (match) {
      return res.status(400).json({
        success: false,
        error: 'New password cannot match your current password.'
      });
    }
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);
    await User.updatePassword(sanitizedEmail, hash);
    passwordResetSessions.delete(sanitizedEmail);

    return res.status(200).json({
      success: true,
      message: 'Password updated successfully.'
    });
  } catch (err) {
    console.error('Password reset error:', err);
    return res.status(200).json({
      success: false,
      error: 'Failed to reset password. Please try again.'
    });
  }
};
