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

// Genders accepted by the profile endpoints. Stored lowercase for consistency.
const ALLOWED_GENDERS = ['male', 'female', 'other', 'prefer not to say'];

// Profile fields that must be unique, with the message the frontend shows when
// the value already belongs to another account. `field` is returned alongside
// `error` so the UI can highlight the offending input.
const DUPLICATE_FIELD_MESSAGES = {
  phone_number: 'This phone number is already registered to another account.',
  license_number: 'This license number is already registered to another account.',
};

// A unique violation names its constraint (`users_phone_number_key`) and repeats
// the column in `detail`, so either one identifies the field. Matching the
// column plus the usual synonyms keeps this working if a constraint is renamed.
const DUPLICATE_FIELD_HINTS = {
  phone_number: /phone|mobile|contact/,
  license_number: /licen[cs]e/,
};

/** Identifies which profile field a Postgres unique violation was raised for. */
const fieldFromUniqueViolation = (err) => {
  const haystack = `${err?.constraint || ''} ${err?.detail || ''} ${err?.message || ''}`.toLowerCase();
  return Object.keys(DUPLICATE_FIELD_MESSAGES).find((field) => DUPLICATE_FIELD_HINTS[field].test(haystack)) || null;
};

/** 409 the frontend renders as "Update failed" with a field-specific reason. */
const sendDuplicateFieldError = (res, field) =>
  res.status(409).json({
    success: false,
    field: field || null,
    error: field
      ? DUPLICATE_FIELD_MESSAGES[field]
      : 'This value is already registered to another account.',
  });

// The exact strength rule registration applies, reused so the two paths cannot
// drift apart. `validate.isStrongPassword` defaults: >=8 chars incl. upper,
// lower, number and symbol.
const STRONG_PASSWORD_MESSAGE =
  'Password must be at least 8 characters long and include uppercase, lowercase, numbers, and symbols.';

/**
 * Resolves which account a profile request targets.
 *
 * The signed-in user's email is authoritative. When a caller also passes an
 * `email` (body for writes, query for reads) it must match the session; otherwise
 * we refuse, so nobody can read or edit another account. Omitting it simply
 * defaults to the session email.
 */
const resolveProfileEmail = (req) => {
  const requested =
    (typeof req.body?.email === 'string' && req.body.email) ||
    (typeof req.query?.email === 'string' && req.query.email) ||
    '';

  const sessionEmail = String(req.user?.email || '').trim().toLowerCase();
  const email = (requested || sessionEmail).trim().toLowerCase();

  if (!email) {
    return { error: 'Email address is required.' };
  }

  if (!validate.isEmail(email)) {
    return { error: 'Invalid Email format' };
  }

  if (sessionEmail && email !== sessionEmail) {
    return { error: 'You can only access your own profile.', forbidden: true };
  }

  return { email };
};

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

// File: backend/controllers/user.js [PROFILE SECTION]

/**
 * GET /user/get-user-details?email=
 *
 * Fetches a user's editable profile (first_name, last_name, phone_number,
 * date_of_birth, gender, license_number) keyed by email. The password hash is
 * intentionally never returned — a login credential must not reach the client.
 */
exports.getUserDetails = async (req, res) => {
  const { email, error, forbidden } = resolveProfileEmail(req);

  if (error) {
    return res.status(forbidden ? 403 : 400).json({ success: false, error });
  }

  try {
    const profile = await User.findProfileByEmail(email);

    if (!profile) {
      return res.status(404).json({ success: false, error: 'No account with that email found.' });
    }

    return res.status(200).json({ success: true, data: profile });
  } catch (err) {
    console.error('Fetch user details error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch user details.' });
  }
};

/**
 * PUT /user/update-user-details
 *
 * Partially updates a user's profile fields — and optionally the password —
 * keyed by email. Only keys present in the body are written, so callers can
 * update a single field. Send `null`/`""` to clear phone_number, date_of_birth,
 * gender or license_number.
 *
 * A supplied password is strength-checked exactly like registration and is
 * hashed here; a raw `password_hash` from the client is never accepted.
 */
exports.updateUserDetails = async (req, res) => {
  const { email, error, forbidden } = resolveProfileEmail(req);

  if (error) {
    return res.status(forbidden ? 403 : 400).json({ success: false, error });
  }

  const body = req.body || {};
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
  const updates = {};

  // --- first_name / last_name ---------------------------------------------
  for (const field of ['first_name', 'last_name']) {
    if (!has(field)) continue;
    const value = typeof body[field] === 'string' ? body[field].trim() : '';
    if (!value) {
      return res.status(400).json({ success: false, error: `${field} cannot be empty.` });
    }
    updates[field] = value;
  }

  // --- phone_number --------------------------------------------------------
  if (has('phone_number')) {
    const raw = body.phone_number;
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      updates.phone_number = null;
    } else {
      const phone = String(raw).replace(/[\s()-]/g, '');
      if (!/^\+?\d{7,15}$/.test(phone)) {
        return res.status(400).json({ success: false, error: 'Invalid phone number format.' });
      }
      updates.phone_number = phone;
    }
  }

  // --- date_of_birth -------------------------------------------------------
  if (has('date_of_birth')) {
    const raw = body.date_of_birth;
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      updates.date_of_birth = null;
    } else {
      const dob = new Date(raw);
      if (Number.isNaN(dob.getTime())) {
        return res.status(400).json({ success: false, error: 'Invalid date_of_birth format.' });
      }
      if (dob.getTime() > Date.now()) {
        return res.status(400).json({ success: false, error: 'date_of_birth cannot be in the future.' });
      }
      updates.date_of_birth = dob.toISOString().slice(0, 10);
    }
  }

  // --- gender --------------------------------------------------------------
  if (has('gender')) {
    const raw = body.gender;
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      updates.gender = null;
    } else {
      const gender = String(raw).trim().toLowerCase();
      if (!ALLOWED_GENDERS.includes(gender)) {
        return res.status(400).json({
          success: false,
          error: `gender must be one of: ${ALLOWED_GENDERS.join(', ')}.`,
        });
      }
      updates.gender = gender;
    }
  }

  // --- license_number ------------------------------------------------------
  if (has('license_number')) {
    const raw = body.license_number;
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      updates.license_number = null;
    } else {
      const license = String(raw).trim();
      if (license.length > 100) {
        return res.status(400).json({ success: false, error: 'license_number is too long.' });
      }
      updates.license_number = license;
    }
  }

  // --- password (validated exactly like registration) ----------------------
  const password = body.password ?? body.new_password;
  let passwordHash = null;

  if (password !== undefined && password !== null && password !== '') {
    if (typeof password !== 'string' || !validate.isStrongPassword(password)) {
      return res.status(400).json({ success: false, error: STRONG_PASSWORD_MESSAGE });
    }

    try {
      const existing = await User.findOne(email);
      if (!existing) {
        return res.status(404).json({ success: false, error: 'No account with that email found.' });
      }
      const sameAsCurrent = await bcrypt.compare(password, existing.password);
      if (sameAsCurrent) {
        return res.status(400).json({ success: false, error: 'New password cannot match your current password.' });
      }
    } catch (err) {
      console.error('Update user details (password check) error:', err);
      return res.status(500).json({ success: false, error: 'Failed to update user details.' });
    }

    const salt = await bcrypt.genSalt(10);
    passwordHash = await bcrypt.hash(password, salt);
  }

  if (Object.keys(updates).length === 0 && !passwordHash) {
    return res.status(400).json({
      success: false,
      error:
        'No updatable fields provided. Allowed: first_name, last_name, phone_number, date_of_birth, gender, license_number, password.',
    });
  }

  // --- duplicate check -----------------------------------------------------
  // Reject a value that another account already owns, so the user is told which
  // field is the problem instead of getting a generic database failure.
  try {
    for (const field of Object.keys(DUPLICATE_FIELD_MESSAGES)) {
      if (!has(field)) continue; // null/"" means "cleared", existsBy ignores it

      if (await User.existsBy(field, updates[field], email)) {
        return sendDuplicateFieldError(res, field);
      }
    }
  } catch (err) {
    // A failed pre-check must never hide the real reason: let the UPDATE below
    // run and translate its unique violation instead of returning a generic 500.
    console.error('Update user details (duplicate pre-check) error:', err);
  }

  try {
    const updated = await User.updateProfileByEmail(email, updates, passwordHash);

    if (!updated) {
      return res.status(404).json({ success: false, error: 'No account with that email found.' });
    }

    return res.status(200).json({
      success: true,
      message: 'User details updated successfully.',
      data: updated,
    });
  } catch (err) {
    console.error('Update user details error:', err);

    // Safety net: another request may claim the same value between the check
    // above and this UPDATE, so translate the unique violation the same way.
    if (err.code === '23505') {
      return sendDuplicateFieldError(res, fieldFromUniqueViolation(err));
    }

    return res.status(500).json({
      success: false,
      error: 'Failed to update user details.',
    });
  }
};
