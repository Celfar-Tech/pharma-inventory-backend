const db = require("../database"); // Imports your database connection wrapper

// Columns the profile-section endpoints are allowed to write. `email`, `role`
// and `password_hash` (handled separately) can never be changed through this
// whitelist, so a tampered payload cannot escalate an account.
const PROFILE_EDITABLE_COLUMNS = {
  first_name: "first_name",
  last_name: "last_name",
  phone_number: "phone_number",
  date_of_birth: "date_of_birth",
  gender: "gender",
  license_number: "license_number",
};

// Columns the profile endpoints require, mapped to their SQL type. These are
// self-healed on first use so older deployments that predate the profile
// section keep working without a manual migration.
const PROFILE_REQUIRED_COLUMNS = {
  date_of_birth: "DATE",
  gender: "VARCHAR(20)",
  phone_number: "VARCHAR(15)",
  license_number: "VARCHAR(100)",
};

// Memoized so the information_schema lookup (+ any DDL) runs at most once per
// process instead of on every profile request.
let profileColumnsReady = null;

class User {
  // 🌟 1. Added `role` as the first parameter to match your controller
  constructor(role, fullname, username, email, passwordHash) {
    // Gracefully split fullname into first_name and last_name for your schema
    const nameParts = fullname ? fullname.trim().split(/\s+/) : [""];
    this.first_name = nameParts[0] || "";
    this.last_name = nameParts.slice(1).join(" ") || "";

    this.username = username;
    this.email = email;
    this.password_hash = passwordHash;

    // 🌟 2. Assign the role from the frontend, with 'patient' as a safe fallback
    this.role = role || "pharmacist"; // Default role is 'pharmacist' if not provided
  }

  // Used by your signUp controller
  async create_user() {
    const query = `
      INSERT INTO pharma.users (role, email, password_hash, username, first_name, last_name)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING user_id AS id, username, email, role;
    `;
    const values = [this.role, this.email, this.password_hash, this.username, this.first_name, this.last_name];

    try {
      const result = await db.query(query, values);
      return result.rows[0];
    } catch (err) {
      throw err; // Throws the error up to your controller's catch block (e.g., code 23505)
    }
  }

  // Used to fetch the logged-in user's profile
  static async findById(id) {
    const query = `
      SELECT user_id AS id, username, email, role, first_name, last_name, phone_number, license_number, status 
      FROM pharma.users 
      WHERE user_id = $1;
    `;
    try {
      const result = await db.query(query, [id]);
      return result.rows[0] || null;
    } catch (err) {
      throw err;
    }
  }

  // Used when provisioning a Google account, whose username is derived from the
  // email address and therefore must be checked for collisions first.
  static async findByUsername(username) {
    const query = `SELECT 1 FROM pharma.users WHERE username = $1 LIMIT 1;`;

    try {
      const result = await db.query(query, [username]);
      return result.rows[0] || null;
    } catch (err) {
      throw err;
    }
  }

  // Used by your logIn controller
  static async findOne(email) {
    // Aliasing user_id -> id and password_hash -> password keeps it compatible with your controller
    const query = `
      SELECT user_id AS id, username, email, password_hash AS password, role 
      FROM pharma.users 
      WHERE email = $1;
    `;

    try {
      const result = await db.query(query, [email]);
      return result.rows[0] || null;
    } catch (err) {
      throw err;
    }
  }

  /**
   * Guarantees the profile columns exist before they are queried.
   *
   * The lookup is memoized and a column is only altered-in when it is genuinely
   * missing, so a healthy schema never triggers DDL (which requires table
   * ownership and would otherwise fail for a restricted app role).
   * @static
   * @async
   * @returns {Promise<void>}
   */
  static async ensureProfileColumns() {
    if (!profileColumnsReady) {
      profileColumnsReady = (async () => {
        const { rows } = await db.query(
          `SELECT column_name
             FROM information_schema.columns
            WHERE table_schema = 'pharma' AND table_name = 'users';`
        );

        const existing = new Set(rows.map((row) => row.column_name));

        for (const [column, type] of Object.entries(PROFILE_REQUIRED_COLUMNS)) {
          if (!existing.has(column)) {
            await db.query(
              `ALTER TABLE pharma.users ADD COLUMN IF NOT EXISTS ${column} ${type};`
            );
          }
        }
      })().catch((err) => {
        // Let a later request retry if the very first attempt failed.
        profileColumnsReady = null;
        throw err;
      });
    }

    return profileColumnsReady;
  }

  /**
   * Fetches the editable profile of the account matching `email`.
   *
   * The password hash is deliberately NOT selected: a login credential must
   * never travel to the client, so it stays server-side only.
   * @static
   * @async
   * @param {string} email
   * @returns {Promise<Object|null>} Profile row, or null when no account matches.
   */
  static async findProfileByEmail(email) {
    await User.ensureProfileColumns();

    const query = `
      SELECT user_id AS id, username, email, role,
             first_name, last_name, phone_number,
             date_of_birth, gender, license_number,
             status, created_at, updated_at
        FROM pharma.users
       WHERE email = $1
       LIMIT 1;
    `;

    try {
      const result = await db.query(query, [email]);
      return result.rows[0] || null;
    } catch (err) {
      throw err;
    }
  }

  /**
   * Applies a partial profile update and/or a new password hash for the account
   * matching `email`.
   *
   * Only whitelisted profile columns can be written; the controller is
   * responsible for validation and for hashing the password before it arrives
   * here.
   * @static
   * @async
   * @param {string} email
   * @param {Object} updates - Subset of PROFILE_EDITABLE_COLUMNS.
   * @param {string|null} passwordHash - Pre-hashed password, or null to leave it.
   * @returns {Promise<Object|null>} Updated profile, or null when nothing to write / no match.
   */
  static async updateProfileByEmail(email, updates = {}, passwordHash = null) {
    await User.ensureProfileColumns();

    const assignments = [];
    const values = [];

    for (const [field, value] of Object.entries(updates)) {
      const column = PROFILE_EDITABLE_COLUMNS[field];
      if (!column) continue;
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    }

    if (passwordHash) {
      values.push(passwordHash);
      assignments.push(`password_hash = $${values.length}`);
    }

    if (assignments.length === 0) {
      return null;
    }

    assignments.push("updated_at = CURRENT_TIMESTAMP");
    values.push(email);

    const query = `
      UPDATE pharma.users
         SET ${assignments.join(", ")}
       WHERE email = $${values.length}
      RETURNING user_id AS id, username, email, role, first_name, last_name,
                phone_number, date_of_birth, gender, license_number, status, updated_at;
    `;

    try {
      const result = await db.query(query, values);
      return result.rows[0] || null;
    } catch (err) {
      throw err;
    }
  }

  // Used by your logIn controller tracking metrics
  static async logged_in(email) {
    const query = `
      UPDATE pharma.users 
      SET updated_at = CURRENT_TIMESTAMP 
      WHERE email = $1;
    `;

    try {
      await db.query(query, [email]);
      return true;
    } catch (err) {
      console.error("Failed to update user login metric:", err);
      return false; // Soft fail so database metrics don't disrupt user login access
    }
  }

  static async updatePassword(email, passwordHash) {
    const query = `
      UPDATE pharma.users
      SET password_hash = $1, updated_at = CURRENT_TIMESTAMP
      WHERE email = $2
      RETURNING user_id AS id, username, email, role;
    `;

    try {
      const result = await db.query(query, [passwordHash, email]);
      return result.rows[0] || null;
    } catch (err) {
      throw err;
    }
  }
}

module.exports = User;